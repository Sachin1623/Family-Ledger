import React, { useMemo, useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { doc, updateDoc, setDoc, collection, query, where } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { useFriendships } from '../../lib/useFriendships';
import { claimPoints } from '../../lib/pointsApi';
import {
  Color,
  COLORS,
  COLOR_HEX,
  LudoPlayer,
  YARD,
  HOME,
  HOME_ENTRY,
  emptyTokens,
  movableTokens,
  applyMove,
  toAbsolute,
  isSafeSquare,
  nextJoinColor,
  nextClockwiseSeat,
  boardSlot,
} from '../../lib/ludo';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { ChatButton, ChatPanel, useGameChat } from '../../components/GameChat';
import InvitePicker from '../../components/InvitePicker';
import PresenceDot from '../../components/PresenceDot';
import ShareGameButton from '../../components/ShareGameButton';
import Fireworks from '../../components/Fireworks';
import { LUDO_HELP } from '../../lib/gameHelp';
import { ReactionButton, ReactionOverlay, useReactionOverlay } from '../../components/GameReactions';
import DiceFace from '../../components/DiceFace';

// Classic 15x15 cross-shaped Ludo board. This exact coordinate list was NOT hand-transcribed from
// the reference image (too easy to get a subtly-wrong cell and never notice) — it was derived by
// modeling the board as a graph (every cell in the outer two rows/cols of each arm, plus the 4
// "turn" corners where an arm's two lanes meet, plus the 4 single-cell "tips" at each arm's outer
// edge where its two lanes cross into the middle column) and walking it as a verified single
// 52-node cycle (every cell has exactly 2 track neighbors, confirmed programmatically before
// this shipped). The 4 corner cells are visual turn-connectors only — never an addressable
// engine position (src/lib/ludo.ts's 0-51 numbering skips them) — see CORNER_CELLS below.
//
// Runs clockwise (verified — real Ludo motion), with index 0 starting on the lane immediately
// adjacent to green's OWN yard (matching the reference board's single colored accent cell there,
// not the lane adjacent to a neighboring color) — the whole array is just that starting cell
// walked clockwise around the loop; every other color's start (in ludo.ts's START_OFFSET) falls
// out from this same array by the board's 90°-rotational symmetry, confirmed programmatically
// (0/13/26/39 — an even split — rather than assumed).
const GRID_SIZE = 15;
const PATH52: [number, number][] = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 7],
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
  [7, 14], [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9], [9, 8], [10, 8], [11, 8], [12, 8],
  [13, 8], [14, 8], [14, 7], [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6], [8, 5], [8, 4],
  [8, 3], [8, 2], [8, 1], [8, 0], [7, 0], [6, 0],
];
const CORNER_CELLS: [number, number][] = [[6, 6], [6, 8], [8, 6], [8, 8]];

// Each color's private 6-cell home stretch (relative position 51 = index 0 here, closest to the
// board edge, through 56 = index 5, closest to the center) — matches START_OFFSET in ludo.ts,
// which was derived from this exact same board layout.
//
// The outer-edge cell of each arm (e.g. green's [7,0]) is NOT usable here — PATH52's own
// corner-turn connector (the only orthogonal bridge between that arm's two shared-track lanes at
// the board's outer edge, since the yards occupy every other cell in that column/row) already
// legitimately sits there, at exactly that color's own relPos 50 (its last shared-track square).
// Reusing it as home-stretch index 0 made relPos 50 and 51 render at the IDENTICAL cell, so
// crossing that boundary looked like the token "lost" one square of every roll that spanned it
// (reported 2026-08-18: a green token needing 4 visibly only moved 3). Fixed by shifting each
// color's stretch one cell further in — dropping the colliding outer cell and extending one cell
// past the old innermost one, which lands exactly on that color's own wedge tip inside the
// center triangle — that 6th cell IS home now (see HOME in ludo.ts), not a step before it.
const HOME_STRETCH_CELLS: Record<Color, [number, number][]> = {
  green: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
  yellow: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]],
  blue: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
  red: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]],
};

// The last cell of each color's stretch (relPos 56 — HOME itself, see ludo.ts) falls inside the
// center 3x3 block's coordinate range — without this, the per-cell render loop's generic "inside
// the center block, skip it" check would swallow it into CenterTriangle's plain colored wedge,
// hiding the token entirely instead of showing it clearly arrived. Listed alongside CORNER_CELLS
// below so it still renders as its own distinct, individually-tinted stretch cell instead.
const FINAL_STRETCH_CELLS: [number, number][] = COLORS.map((c) => HOME_STRETCH_CELLS[c][5]);

const YARD_SPANS: Record<Color, { rows: [number, number]; cols: [number, number] }> = {
  green: { rows: [0, 5], cols: [0, 5] },
  yellow: { rows: [0, 5], cols: [9, 14] },
  red: { rows: [9, 14], cols: [0, 5] },
  blue: { rows: [9, 14], cols: [9, 14] },
};

// Chess-style per-viewer rotation: the board is always laid out in this same fixed canonical
// orientation (green=TL, yellow=TR, blue=BR, red=BL — see YARD_SPANS above), but each viewer sees
// it rotated so THEIR OWN color's yard always renders at bottom-left, matching how a chess board
// flips to put each player's own pieces at the bottom. Clockwise degrees needed to carry a given
// color's fixed quadrant around to bottom-left (red is already there, hence 0). Applied as a
// single CSS `rotate()` on the whole grid container — every cell, the token overlay, and the
// center wedges all rotate together as one rigid unit for free; only each token's own inner
// content (its pawn shape + number) gets counter-rotated back upright, same as text on a rotated
// chessboard square staying legible.
const ROTATION_DEG: Record<Color, number> = { red: 0, blue: 90, yellow: 180, green: 270 };

// `slot` is a PHYSICAL board quadrant (see boardSlot in ludo.ts), not necessarily the player's
// own chosen display color — callers are responsible for resolving that first. HOME (56) is
// itself the 6th and last home-stretch cell now — not a separate position beyond it — so this
// deliberately includes relPos === HOME, not just relPos < HOME.
function homeStretchCell(slot: Color, relPos: number): [number, number] | null {
  if (relPos < HOME_ENTRY || relPos > HOME) return null;
  return HOME_STRETCH_CELLS[slot][relPos - HOME_ENTRY];
}

// Same pawn silhouette and 3D dice design as Business, for a consistent look/feel across this
// app's board games — see BusinessGame.tsx's PawnToken/DiceFace for the original design notes.
const PawnToken: React.FC<{ color: string; size?: number }> = ({ color, size = 16 }) => {
  const gradId = `ludoPawnGrad-${color.replace('#', '')}`;
  const shadeId = `ludoPawnShade-${color.replace('#', '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 100 140" className="shrink-0 drop-shadow-lg" style={{ overflow: 'visible' }}>
      <defs>
        <radialGradient id={gradId} cx="32%" cy="24%" r="90%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="22%" stopColor={color} stopOpacity="1" />
          <stop offset="78%" stopColor={color} stopOpacity="1" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.4" />
        </radialGradient>
        <linearGradient id={shadeId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <ellipse cx="50" cy="129" rx="30" ry="8" fill="#000000" opacity="0.25" />
      <ellipse cx="50" cy="121" rx="29" ry="11" fill={`url(#${gradId})`} stroke="#000000" strokeOpacity="0.4" strokeWidth="2" />
      <path d="M 33 116 C 30 94, 37 68, 42 54 L 58 54 C 63 68, 70 94, 67 116 Z" fill={`url(#${gradId})`} stroke="#000000" strokeOpacity="0.4" strokeWidth="2" />
      <ellipse cx="50" cy="54" rx="15" ry="6" fill={`url(#${gradId})`} stroke="#000000" strokeOpacity="0.4" strokeWidth="2" />
      <circle cx="50" cy="29" r="23" fill={`url(#${gradId})`} stroke="#000000" strokeOpacity="0.4" strokeWidth="2" />
      <ellipse cx="42" cy="20" rx="8" ry="6" fill="#ffffff" opacity="0.75" />
      <path d="M 36 60 C 34 80, 38 100, 42 114 L 47 114 C 44 98, 41 78, 42 58 Z" fill={`url(#${shadeId})`} />
    </svg>
  );
};

// DiceFace itself now lives in src/components/DiceFace.tsx, shared with every other game that
// rolls dice (Business, …) — see its own file for the isometric-cube design notes.

// Continuous (fractional) grid coordinates for a token's CURRENT logical state, used to drive the
// smooth-movement animation below. Track/home-stretch cells are always integers (matching PATH52 /
// HOME_STRETCH_CELLS exactly) and are positioned by their top-left corner, needing +0.5 at render
// time to reach the cell's center; the yard slots are pre-computed as an already-centered absolute
// board fraction instead (see yardSlotFrac) and must NOT get that +0.5 added again. `isYard` travels
// bundled with the coordinate itself (not re-derived separately from a token's live position at
// render time) specifically so the two can never drift out of sync — they used to be computed
// independently, and for one render frame right as a token left the yard, the coordinate was still
// the old yard-style value while the separately-computed flag had already flipped to "not yard",
// causing +0.5 to be wrongly applied to a yard coordinate and the token to visibly flick back
// toward the yard before snapping to its real position on the next frame.
interface GridPos { row: number; col: number; isYard: boolean }

function yardSlotFrac(tokenIndex: number): { rowFrac: number; colFrac: number } {
  return { rowFrac: tokenIndex < 2 ? 0.32 : 0.68, colFrac: tokenIndex % 2 === 0 ? 0.32 : 0.68 };
}

// `slot` is the PHYSICAL board quadrant a token's owner occupies (see boardSlot in ludo.ts) —
// NOT necessarily that player's own freely-chosen display color (see handleJoin further down).
// Callers must resolve `boardSlot(player.seatIndex, players.length)` before calling this; the
// token's actual pawn FILL color still comes from the player's real `color` field separately.
function tokenGridPosition(slot: Color, tokenIndex: number, pos: number): GridPos {
  if (pos === YARD) {
    const { rows, cols } = YARD_SPANS[slot];
    const { rowFrac, colFrac } = yardSlotFrac(tokenIndex);
    return { row: rows[0] + rowFrac * (rows[1] - rows[0] + 1), col: cols[0] + colFrac * (cols[1] - cols[0] + 1), isYard: true };
  }
  // No separate "finished" cluster near the center anymore — HOME (56) IS the stretch's own last
  // cell, so a finished token just sits right there, on the same tile it was already heading
  // toward (multiple finished tokens of the same color stack there via the normal same-cell
  // offset logic in the token overlay below, same as any other crowded cell).
  if (pos >= HOME_ENTRY) {
    const cell = homeStretchCell(slot, pos);
    if (cell) return { row: cell[0], col: cell[1], isYard: false };
  }
  // Defensive: `pos` ultimately comes from Firestore, so a NaN/malformed token value (never
  // expected, but not impossible from stale/corrupted game state) must fall back to a safe
  // on-board cell instead of indexing PATH52 with an out-of-range key and crashing the render.
  const abs = toAbsolute(slot, Math.max(0, Math.min(Number(pos) || 0, 50)));
  const cell = abs != null ? PATH52[abs] : undefined;
  return cell ? { row: cell[0], col: cell[1], isYard: false } : { row: 7, col: 7, isYard: false };
}

const SAFE_CELL_KEYS = new Set(Array.from(isSafeSquareIndices()).map((i) => PATH52[i].join(',')));
function isSafeSquareIndices(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 52; i++) if (isSafeSquare(i)) out.push(i);
  return out;
}

// Shows the exact remaining distance to HOME (56 — the stretch's own last visible cell, see
// ludo.ts) rather than "Stretch N/6", which didn't directly answer the one question that matters
// for the exact-roll rule: how many more do I need. What's on screen and what the dice needs are
// now the same number — no invisible extra step past the last cell anyone can see.
function statusLabel(pos: number): string {
  if (pos === YARD) return 'Yard';
  if (pos === HOME) return 'Home';
  if (pos >= HOME_ENTRY) return `${HOME - pos} to go`;
  return `${pos}`;
}

export default function LudoGame() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { friendCandidates } = useFriendships(user?.uid);
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const { messages: chatMessages, loading: chatLoading, hasUnseen: chatUnseen, markSeen: markChatSeen } = useGameChat('ludoGames', gameId);
  // A tapped "new chat message" push/in-app banner deep-links here as `?chat=1` (see
  // /api/chat/send's bannerTo + InviteBanner.tsx) — auto-opens the chat panel instead of just
  // landing on the game screen, same pattern as Dashboard.tsx's `?dm=` for direct messages.
  const [searchParams, setSearchParams] = useSearchParams();
  const [showChat, setShowChat] = useState(false);
  // Reacts to searchParams itself, not a mount-only effect — if this screen's already mounted
  // (this same game already open) when the notification is tapped, React Router reuses the
  // instance instead of remounting it, so a mount-only effect would never see the new `chat=1`.
  useEffect(() => {
    if (searchParams.get('chat') === '1') {
      setShowChat(true);
      const next = new URLSearchParams(searchParams);
      next.delete('chat');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const [gameDoc, loading] = useDocument(gameId ? doc(db, 'ludoGames', gameId) : null);
  const game = gameDoc?.exists() ? (gameDoc.data() as any) : null;

  // Ludo is the one game whose finish write is client-direct (see handleMoveToken above), not
  // server-mediated like Rummy/Sweep/Sequence — so points can't be awarded inline there. Every
  // player's own client watches this same live doc and claims once it flips to 'finished',
  // deduped per gameId so a re-render (or the winner's own write triggering this same effect)
  // never sends more than one claim.
  const claimedLudoResultRef = React.useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!gameId || !user || game?.status !== 'finished') return;
    if (claimedLudoResultRef.current.has(gameId)) return;
    claimedLudoResultRef.current.add(gameId);
    claimPoints('ludo_result', { gameId });
  }, [gameId, user, game?.status]);

  const floatingReactions = useReactionOverlay(game?.lastReaction);
  const handleSendReaction = async (emoji: string) => {
    if (!user || !gameId) return;
    try {
      const idToken = await user.getIdToken();
      await fetch('/api/games/react', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameType: 'ludo', gameId, emoji }),
      });
    } catch (err) {
      console.error('Failed to send reaction:', err);
    }
  };

  // Presence: lets the server skip notifying this user about their own turn while they're
  // actually looking at this exact game (the live Firestore listener already shows it) —
  // see /api/notify-ludo-turn. Tracks visibility too, not just mount/unmount: backgrounding the
  // app while still "on" this screen must count as not-present, or a backgrounded user would
  // never get notified it's their turn.
  useEffect(() => {
    if (!user || !gameId) return;
    const setPresence = (val: string | null) => {
      setDoc(doc(db, 'users', user.uid), { activeLudoGameId: val }, { merge: true }).catch(() => {});
    };
    const onVisibility = () => setPresence(document.visibilityState === 'visible' ? gameId : null);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      setPresence(null);
    };
  }, [user, gameId]);

  // Defensive cleanup: if a turn-indicator pill is showing for this exact game and the user got
  // here some other way (e.g. the lobby's "Your Games" list, not tapping the pill itself), clear
  // it so it doesn't linger after they've already seen the game.
  useEffect(() => {
    if (!user || !gameId) return;
    if (profile?.ludoTurnIndicator?.gameId === gameId) {
      setDoc(doc(db, 'users', user.uid), { ludoTurnIndicator: null }, { merge: true }).catch(() => {});
    }
  }, [user, gameId, profile?.ludoTurnIndicator?.gameId]);

  const [groupsMembersValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = groupsMembersValue?.docs.map((d) => d.data().groupId) || [];
  const [showInvite, setShowInvite] = useState(false);

  const players: LudoPlayer[] = game?.players || [];
  const myPlayer = players.find((p) => p.uid === user?.uid);
  const isPlayer = !!myPlayer;
  // Spectators (not seated) see the board in its plain canonical orientation — there's no "own
  // perspective" to rotate toward. Rotated to the viewer's PHYSICAL slot (see boardSlot in
  // ludo.ts), not their freely-chosen display color — those two only happen to coincide when a
  // player's chosen color matches the slot name, which isn't guaranteed anymore.
  const myRotation = myPlayer ? ROTATION_DEG[boardSlot(myPlayer.seatIndex, players.length)] : 0;
  // Decorative colors (yard box background, home-stretch lane tint, center triangle wedge) are
  // drawn per PHYSICAL SLOT, but a slot's occupant can now be ANY color (see boardSlot in ludo.ts)
  // — so each slot must borrow whichever player actually sits there's real `color` for its
  // decoration, not its own canonical slot name, or the yard box color visibly mismatches the
  // pawns inside it. An empty slot can't just default to its OWN canonical name either — that
  // name might already be some occupied slot's actual chosen color (e.g. someone picks "red" for
  // the physical blue slot while the physical red slot sits empty, producing two red boxes) — so
  // empty slots instead borrow from whichever colors are genuinely unused by anyone seated.
  const slotColors = {} as Record<Color, Color>;
  COLORS.forEach((slot) => {
    const occupant = players.find((p) => boardSlot(p.seatIndex, players.length) === slot);
    if (occupant) slotColors[slot] = occupant.color;
  });
  const unusedColors = COLORS.filter((c) => !players.some((p) => p.color === c));
  COLORS.forEach((slot) => { if (!slotColors[slot]) slotColors[slot] = unusedColors.shift()!; });
  const isMyTurn = isPlayer && game && players[game.currentTurnSeatIndex]?.uid === user?.uid;
  const dice: number | null = game?.diceValue ?? null;
  // The current player must roll before moving — separate from `dice` itself, which now always
  // holds the LAST rolled value (never reset to null) so the die is never blank between turns;
  // `awaitingRoll` is what actually gates "can roll" / "can move" instead.
  const awaitingRoll = game?.awaitingRoll ?? true;
  const movable = isMyTurn && myPlayer && !awaitingRoll && dice != null ? movableTokens(myPlayer.tokens, dice) : [];

  // Which color, if any, this viewer is about to join as — a picker in the waiting room lets
  // them freely choose ANY unclaimed color (see handleJoin), completely independent of anyone
  // else's choice. The board's PHYSICAL layout no longer depends on color at all (see boardSlot
  // in ludo.ts) — seating is purely a function of join order, so any combination of colors always
  // renders sensibly (2 players opposite, 3-4 spread around the board) with zero restriction here.
  const availableJoinColors = COLORS.filter((c) => !players.some((p) => p.color === c));
  const [selectedJoinColor, setSelectedJoinColor] = useState<Color | null>(null);
  useEffect(() => {
    if (isPlayer) return;
    if (selectedJoinColor && availableJoinColors.includes(selectedJoinColor)) return;
    const suggested = players.length === 0 ? availableJoinColors[0] : nextJoinColor(players.map((p) => p.color));
    setSelectedJoinColor(availableJoinColors.includes(suggested) ? suggested : availableJoinColors[0] || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players.map((p) => p.color).join(','), isPlayer]);

  // A locally-selected token (always one of the VIEWER's own 4, never another player's) — first
  // click on a "Your Tokens" button just highlights/enlarges it on the board so it's findable
  // even under a stack of other tokens on the same cell; a second click on the same button
  // actually moves it (only if it's legally movable right now). This works identically whether
  // or not it's currently this viewer's turn, so anyone can locate their own tokens at any time.
  const [selectedTokenIndex, setSelectedTokenIndex] = useState<number | null>(null);
  const [justVoided, setJustVoided] = useState(false);
  const voidNotice = game?.lastVoidNotice;
  useEffect(() => {
    if (!voidNotice?.at) return;
    if (Date.now() - new Date(voidNotice.at).getTime() > 4000) return; // stale from before mount
    setJustVoided(true);
    const t = setTimeout(() => setJustVoided(false), 3000);
    return () => clearTimeout(t);
  }, [voidNotice?.at]);

  // Always-current refs to the live game/players — read inside the auto-pass timeout below
  // instead of closing over the `game`/`players` values from whenever that timeout was
  // SCHEDULED. Without this, a "no legal moves, pass in 1200ms" timer set on one roll could fire
  // well after the player got a bonus roll and moved again (or even after their NEXT turn
  // started), unconditionally overwriting `players` with a stale pre-move snapshot — the root
  // cause of a reported bug where reaching HOME didn't grant a re-roll, and a later roll appeared
  // to move an already-home pawn (really: reverted it, since the stale write clobbered the whole
  // players array back to before it finished).
  const latestGameRef = React.useRef(game);
  const latestPlayersRef = React.useRef(players);
  useEffect(() => {
    latestGameRef.current = game;
    latestPlayersRef.current = players;
  });
  // At most one pending "pass the turn" timer at a time — any fresh roll or move cancels
  // whatever was pending, since the situation that justified it no longer holds.
  const pendingPassRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingPass = () => {
    if (pendingPassRef.current) {
      clearTimeout(pendingPassRef.current);
      pendingPassRef.current = null;
    }
  };
  useEffect(() => cancelPendingPass, []); // clear on unmount too

// Tokens slide smoothly instead of teleporting between cells — a client-only visual overlay on
  // top of the authoritative Firestore `tokens` positions (which still update instantly; game
  // logic never waits on this), same pattern as Business's `displayPositions`. This used to walk
  // step-by-step through every intermediate track cell with a manually-scheduled setTimeout chain,
  // but that approach had a real, hard-to-fully-close class of bugs: a token that got a SECOND
  // move (a bonus roll from a 6/capture/finish is the common case) before its first walk's chain
  // finished could end up desynced or visually frozen at a stale intermediate cell, since the walk
  // was reasoning about "which step am I on" rather than "where does this token actually belong
  // right now." Recomputing the target position directly on every change and letting the
  // `transition-[left,top]` CSS on each token's div do the interpolation removes that whole failure
  // mode — there's no manual step state to ever get out of sync with the real position, so the
  // token can never render anywhere other than where it actually is (mid-slide or settled).
  const [displayPositions, setDisplayPositions] = useState<Record<string, GridPos>>({});
  // Includes each player's COLOR, not just their token values — a color change (see
  // handleChangeColor) doesn't touch any token's position number (a token still sitting in the
  // yard is still just YARD before and after), so without this a color switch would silently
  // leave every cached position computed under the OLD color: the pawn's fill immediately
  // recolors (that reads `p.color` fresh every render) but it stays parked in the old color's
  // yard box / track lane until something else nudges a real token move. Reported via screenshot:
  // a player who was red showed their (correctly red-colored) pawns sitting inside green's yard.
  const positionsKey = players.map((p) => `${p.uid}:${p.color}:${p.tokens.join(',')}`).join('|');

  useEffect(() => {
    if (!game) return;
    const next: Record<string, GridPos> = {};
    players.forEach((p) => {
      const slot = boardSlot(p.seatIndex, players.length);
      p.tokens.forEach((pos, tokenIndex) => {
        next[`${p.uid}:${tokenIndex}`] = tokenGridPosition(slot, tokenIndex, pos);
      });
    });
    setDisplayPositions(next);
    setSelectedTokenIndex(null); // any token position change (a move, or getting captured back to yard) clears a stale highlight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionsKey, gameId]);

  if (loading) return <div className="p-8 text-center text-sm text-text-muted">Loading…</div>;
  if (!game) return <div className="p-8 text-center text-sm text-text-muted">Game not found.</div>;

  const handleJoin = async () => {
    if (!user || isPlayer || players.length >= 4) return;
    setError(null);
    const color = selectedJoinColor || nextJoinColor(players.map((p) => p.color));
    if (players.some((p) => p.color === color)) {
      setError('That color was just taken by someone else — pick another.');
      return;
    }
    try {
      const newPlayer: LudoPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        color,
        seatIndex: players.length,
        tokens: emptyTokens(),
        finishedCount: 0,
      };
      // Fully free choice, completely independent of anyone else's color — the board's PHYSICAL
      // layout (see boardSlot in ludo.ts) is what guarantees a 2-player game seats them opposite
      // each other, based purely on join order, so there's no need to touch (or even look at)
      // the other player's color here at all.
      await updateDoc(doc(db, 'ludoGames', gameId!), {
        players: [...players, newPlayer],
        playerUids: [...players.map((p) => p.uid), user.uid],
      });
    } catch (err) {
      console.error('Failed to join game:', err);
      setError('Failed to join — the game may already be full or started.');
    }
  };

  // Lets ANY already-seated player — including the host, who never went through handleJoin's
  // picker since they're auto-added with a default color at game creation (see LudoLobby.tsx) —
  // change their color anytime before the game actually starts. Fully free and completely
  // independent of anyone else's color — see handleJoin's comment for why the board's physical
  // seating (based on join order, not color) makes that safe.
  const handleChangeColor = async (newColor: Color) => {
    if (!myPlayer || game.status !== 'waiting') return;
    if (newColor === myPlayer.color) return;
    if (players.some((p) => p.uid !== myPlayer.uid && p.color === newColor)) return;
    const updatedPlayers = players.map((p) => (p.uid === myPlayer.uid ? { ...p, color: newColor } : p));
    await updateDoc(doc(db, 'ludoGames', gameId!), { players: updatedPlayers }).catch((err) => {
      console.error('Failed to change color:', err);
      setError('Failed to change color.');
    });
  };

  // Only ever offered when exactly 4 players are seated — each player picks their own team (0 or
  // 1) independently; there's no requirement that it end up an even 2-2 split before starting,
  // since capture immunity (see applyMove) only ever looks at whether two SPECIFIC players share
  // a team, not at the split as a whole. Toggling your own choice off (tapping the team you're
  // already on) clears it back to "no team."
  const handleChangeTeam = async (team: 0 | 1) => {
    if (!myPlayer || game.status !== 'waiting') return;
    const nextTeam = myPlayer.team === team ? null : team;
    const updatedPlayers = players.map((p) => (p.uid === myPlayer.uid ? { ...p, team: nextTeam } : p));
    await updateDoc(doc(db, 'ludoGames', gameId!), { players: updatedPlayers }).catch((err) => {
      console.error('Failed to change team:', err);
      setError('Failed to change team.');
    });
  };

  const handleStart = async () => {
    if (!user || game.hostUid !== user.uid || players.length < 2) return;
    await updateDoc(doc(db, 'ludoGames', gameId!), {
      status: 'active',
      startedAt: new Date().toISOString(),
      currentTurnSeatIndex: 0,
      diceValue: 1, // never blank — this is just a placeholder face until the first real roll
      awaitingRoll: true,
      consecutiveSixes: 0,
      turnStartPlayers: players,
    });
  };

  const notifyNextPlayer = (nextUid: string) => {
    user?.getIdToken().then((idToken) =>
      fetch('/api/notify-ludo-turn', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, nextPlayerUid: nextUid }),
      }),
    ).catch((err) => console.error('notify-ludo-turn failed:', err));
  };

  // Ends the current turn and hands play to the next SEATED player in true board-clockwise order
  // (see nextClockwiseSeat — NOT seatIndex+1, which only reflects join order). Snapshots
  // `currentPlayers` as the new current player's turn-start state, so a three-6 streak on their
  // turn has something to revert to. `currentPlayers`/`extraFields` let a caller that just wrote
  // a fresh `players` array (e.g. after a move) fold that into this same update instead of racing
  // a second write against the stale `players` closure value. `fromSeatIndex` defaults to this
  // render's `game.currentTurnSeatIndex`, but a delayed caller (the auto-pass timeout below) can
  // pass the LATEST value explicitly instead of trusting its own stale closure over `game`.
  const advanceTurn = async (
    currentPlayers: LudoPlayer[] = players,
    extraFields: Record<string, any> = {},
    fromSeatIndex: number = game.currentTurnSeatIndex,
  ) => {
    const nextSeat = nextClockwiseSeat(currentPlayers, fromSeatIndex);
    await updateDoc(doc(db, 'ludoGames', gameId!), {
      ...extraFields,
      currentTurnSeatIndex: nextSeat,
      awaitingRoll: true,
      consecutiveSixes: 0,
      turnStartPlayers: currentPlayers,
    });
    notifyNextPlayer(currentPlayers[nextSeat].uid);
  };

  const handleRoll = async () => {
    if (!isMyTurn || !awaitingRoll || rolling) return;
    cancelPendingPass();
    setRolling(true);
    const value = Math.floor(Math.random() * 6) + 1;
    // Matches DiceFace's roll animation duration, so the number lands right as the die visually
    // settles instead of updating mid-tumble or after a lingering pause.
    await new Promise((r) => setTimeout(r, 900));
    setRolling(false);
    const nextSixStreak = value === 6 ? (game.consecutiveSixes || 0) + 1 : 0;

    if (nextSixStreak >= 3) {
      // Three 6's in a row voids the ENTIRE streak, not just this roll — revert every move made
      // since this player's turn began (including any captures) back to the turn-start snapshot,
      // then let the SAME player roll again fresh, rather than passing to the next seat.
      await updateDoc(doc(db, 'ludoGames', gameId!), {
        players: game.turnStartPlayers || players,
        diceValue: value,
        consecutiveSixes: 0,
        awaitingRoll: true,
        lastVoidNotice: { at: new Date().toISOString(), playerName: myPlayer?.displayName || 'A player' },
      });
      return;
    }

    await updateDoc(doc(db, 'ludoGames', gameId!), { diceValue: value, consecutiveSixes: nextSixStreak, awaitingRoll: false });
    const legal = myPlayer ? movableTokens(myPlayer.tokens, value) : [];
    if (legal.length === 0) {
      pendingPassRef.current = setTimeout(() => {
        pendingPassRef.current = null;
        // Re-validate against the LATEST live state, not the snapshot from when this timer was
        // scheduled — if the player has since rolled again, moved, or the turn already changed
        // some other way, this pass is stale and must be a no-op rather than clobbering whatever
        // actually happened since.
        const g = latestGameRef.current;
        const p = latestPlayersRef.current;
        if (!g || g.status !== 'active' || g.awaitingRoll !== false || g.diceValue == null) return;
        advanceTurn(p, {}, g.currentTurnSeatIndex);
      }, 1200);
    }
  };

  const handleMoveToken = async (tokenIndex: number) => {
    if (!isMyTurn || awaitingRoll || dice == null || !movable.includes(tokenIndex)) return;
    cancelPendingPass();
    try {
      const seatIndex = game.currentTurnSeatIndex;
      const result = applyMove(players, seatIndex, tokenIndex, dice);
      const mover = result.players[seatIndex];
      const won = mover.tokens.every((t) => t === HOME);

      if (won) {
        await updateDoc(doc(db, 'ludoGames', gameId!), {
          players: result.players,
          status: 'finished',
          winnerUid: mover.uid,
          finishedAt: new Date().toISOString(),
        });
        return;
      }

      if (result.bonusRoll) {
        await updateDoc(doc(db, 'ludoGames', gameId!), { players: result.players, awaitingRoll: true });
      } else {
        await advanceTurn(result.players, { players: result.players });
      }
    } catch (err: any) {
      console.error('Failed to move token:', err);
      setError(err?.message || 'Failed to move that token.');
    }
  };

  // First click on one of the viewer's own token buttons just selects/enlarges it on the board —
  // useful on its own to locate a token buried in a stack, or to check where your tokens are
  // during someone else's turn. A second click on the SAME button either moves it (if it's this
  // viewer's turn and that token is legally movable) or simply deselects it.
  const handleTokenButtonClick = (tokenIndex: number) => {
    if (selectedTokenIndex === tokenIndex) {
      if (isMyTurn && movable.includes(tokenIndex)) {
        handleMoveToken(tokenIndex);
      } else {
        setSelectedTokenIndex(null);
      }
    } else {
      setSelectedTokenIndex(tokenIndex);
    }
  };

  const handleEndGame = async () => {
    if (!isPlayer) return;
    if (!window.confirm('End this game now for everyone? This can\'t be undone.')) return;
    await updateDoc(doc(db, 'ludoGames', gameId!), {
      status: 'finished',
      winnerUid: null,
      endedBy: user?.uid || null,
      endedByName: myPlayer?.displayName || null,
      finishedAt: new Date().toISOString(),
    });
  };

  const handleInvite = async (inviteeUids: string[], poke = false) => {
    if (!user || inviteeUids.length === 0) return;
    const idToken = await user.getIdToken();
    await fetch('/api/ludo/invite', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, inviteeUids, poke }),
    }).catch((err) => console.error('ludo invite failed:', err));
    if (!poke) setShowInvite(false);
  };

  const handleCopyCode = () => {
    navigator.clipboard?.writeText(game.code).catch(() => {});
  };

  // Host-only, and only while the game hasn't started (server also enforces this) — an active
  // game has other players mid-match, so they should just leave it be instead.
  const handleDeleteGame = async () => {
    if (!user) return;
    if (!window.confirm('Delete this game? This cannot be undone.')) return;
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/ludo/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete game.');
      navigate('/games/ludo');
    } catch (err: any) {
      console.error('Failed to delete Ludo game:', err);
      setError(err.message || 'Failed to delete game.');
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <ReactionOverlay reactions={floatingReactions} />
      <main className="flex-1 p-4 md:p-6 max-w-md mx-auto w-full space-y-5 pb-24">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button onClick={() => navigate('/games/ludo')} className="text-xs font-bold text-primary flex items-center gap-1">
              <span className="material-symbols-outlined text-[16px]">arrow_back</span>
              Ludo
            </button>
            <ReactionButton onSend={handleSendReaction} />
          </div>
          <div className="flex items-center gap-2">
            {isPlayer && game.status === 'active' && (
              <button onClick={handleEndGame} className="p-2 text-error shrink-0" aria-label="Leave game">
                <span className="material-symbols-outlined text-[22px] block">logout</span>
              </button>
            )}
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
        </div>

        {showHelp && <GameHelpModal content={LUDO_HELP} onClose={() => setShowHelp(false)} />}

        {showChat && user && (
          <ChatPanel
            collectionName="ludoGames"
            gameId={gameId!}
            messages={chatMessages}
            loading={chatLoading}
            myUid={user.uid}
            myDisplayName={profile?.displayName || user.displayName || 'Player'}
            myPhotoURL={profile?.photoURL || user.photoURL || ''}
            otherUids={players.filter((p) => p.uid !== user.uid).map((p) => p.uid)}
            onClose={() => setShowChat(false)}
          />
        )}

        {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

        {game.status === 'waiting' && (
          <div className="bg-white rounded-2xl border border-border-subtle p-5 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-primary">Waiting for players ({players.length}/4)</p>
              <div className="flex items-center gap-1.5">
                <button onClick={handleCopyCode} className="text-xs font-bold text-primary flex items-center gap-1 px-3 py-1.5 bg-primary/5 rounded-full">
                  <span className="material-symbols-outlined text-[14px]">content_copy</span>
                  {game.code}
                </button>
                <ShareGameButton
                  gameLabel="Ludo"
                  code={game.code}
                  path={`/games/ludo/${gameId}`}
                  className="text-xs font-bold text-white flex items-center gap-1 px-3 py-1.5 bg-[#25D366] rounded-full"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {players.map((p) => (
                <div key={p.uid} className="flex items-center gap-2 px-3 py-1.5 rounded-full text-white text-xs font-bold" style={{ backgroundColor: COLOR_HEX[p.color] }}>
                  {p.displayName}
                </div>
              ))}
            </div>

            {!isPlayer && players.length < 4 && (
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Choose your color</p>
                <div className="flex gap-2">
                  {COLORS.map((c) => {
                    const disabled = !availableJoinColors.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        disabled={disabled}
                        onClick={() => setSelectedJoinColor(c)}
                        aria-label={c}
                        className={clsx(
                          'flex-1 h-10 rounded-xl border-2 transition-all',
                          disabled ? 'opacity-20 cursor-not-allowed' : 'active:scale-95',
                          selectedJoinColor === c && !disabled && 'ring-2 ring-offset-2 ring-primary',
                        )}
                        style={{ backgroundColor: COLOR_HEX[c], borderColor: selectedJoinColor === c ? '#fff' : 'transparent' }}
                      />
                    );
                  })}
                </div>
                <button onClick={handleJoin} disabled={!selectedJoinColor} className="w-full py-3 bg-primary text-white font-bold rounded-2xl disabled:opacity-40">
                  Join Game
                </button>
              </div>
            )}

            {isPlayer && (
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Your color</p>
                <div className="flex gap-2">
                  {COLORS.map((c) => {
                    const disabled = c !== myPlayer!.color && !availableJoinColors.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        disabled={disabled}
                        onClick={() => handleChangeColor(c)}
                        aria-label={c}
                        className={clsx(
                          'flex-1 h-10 rounded-xl border-2 transition-all',
                          disabled ? 'opacity-20 cursor-not-allowed' : 'active:scale-95',
                          myPlayer!.color === c && 'ring-2 ring-offset-2 ring-primary',
                        )}
                        style={{ backgroundColor: COLOR_HEX[c], borderColor: myPlayer!.color === c ? '#fff' : 'transparent' }}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {isPlayer && players.length === 4 && (
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">
                  Teams (optional) — teammates can't capture each other's pawns
                </p>
                <div className="flex gap-2">
                  {([0, 1] as const).map((team) => {
                    const onTeam = players.filter((p) => p.team === team);
                    const mine = myPlayer!.team === team;
                    return (
                      <button
                        key={team}
                        type="button"
                        onClick={() => handleChangeTeam(team)}
                        className={clsx(
                          'flex-1 py-2 px-2 rounded-xl border-2 text-left transition-all',
                          mine ? 'border-primary bg-primary/5' : 'border-border-subtle active:scale-95',
                        )}
                      >
                        <p className="text-[10px] font-bold text-primary uppercase tracking-wide">Team {team === 0 ? 'A' : 'B'}</p>
                        <p className="text-[11px] text-text-muted truncate">
                          {onTeam.length > 0 ? onTeam.map((p) => p.displayName).join(', ') : 'Tap to join'}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {isPlayer && (
              <button onClick={() => setShowInvite((v) => !v)} className="w-full py-2.5 border border-border-subtle text-primary font-bold rounded-xl text-sm flex items-center justify-center gap-2">
                <span className="material-symbols-outlined text-[18px]">group_add</span>
                Invite Group Members
              </button>
            )}

            {showInvite && (
              <InvitePicker groupIds={groupIds} alreadyIn={players.map((p) => p.uid)} onInvite={handleInvite} extraCandidates={friendCandidates} />
            )}

            {game.hostUid === user?.uid && (
              <button onClick={handleStart} disabled={players.length < 2} className="w-full py-3 bg-primary text-white font-bold rounded-2xl disabled:opacity-40">
                Start Game {players.length < 2 && '(need 2+ players)'}
              </button>
            )}

            {game.hostUid === user?.uid && (
              <button onClick={handleDeleteGame} className="w-full py-2.5 text-error/70 font-bold text-sm">
                Delete Game
              </button>
            )}
          </div>
        )}

        {game.status === 'finished' && (
          <div className="relative bg-white rounded-2xl border border-border-subtle p-6 text-center space-y-3 overflow-hidden">
            {game.winnerUid && <Fireworks />}
            <span className="relative material-symbols-outlined text-4xl text-primary">{game.winnerUid ? 'emoji_events' : 'flag'}</span>
            <p className="relative text-lg font-black text-primary">
              {game.winnerUid
                ? `${players.find((p) => p.uid === game.winnerUid)?.displayName || 'Someone'} won!`
                : `Game ended early${game.endedByName ? ` by ${game.endedByName}` : ''}.`}
            </p>
            <button onClick={() => navigate('/games/ludo')} className="relative w-full py-3 bg-primary text-white font-bold rounded-2xl">
              Back to Ludo
            </button>
            {user?.uid === game.hostUid && (
              <button onClick={handleDeleteGame} className="relative w-full py-2.5 text-error/70 font-bold text-sm">
                Delete Game
              </button>
            )}
          </div>
        )}

        {/* Board + tokens stay visible in BOTH active and finished states — only the roll/move
            controls further down are active-only — so finishing a game never yanks the board out
            from under the win banner above. */}
        {(game.status === 'active' || game.status === 'finished') && (
          <>
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {players.map((p, seat) => (
                <div
                  key={p.uid}
                  className={clsx(
                    'shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border-2',
                    seat === game.currentTurnSeatIndex ? 'text-white' : 'text-white/90',
                  )}
                  style={{ backgroundColor: COLOR_HEX[p.color], borderColor: seat === game.currentTurnSeatIndex ? '#fff' : COLOR_HEX[p.color] }}
                >
                  <PresenceDot uid={p.uid} className="w-2 h-2" />
                  {p.displayName} {seat === game.currentTurnSeatIndex && '•'}
                </div>
              ))}
            </div>

            {players.length === 4 && (() => {
              const teamA = players.filter((p) => p.team === 0);
              const teamB = players.filter((p) => p.team === 1);
              if (teamA.length === 0 || teamB.length === 0) return null;
              return (
                <p className="text-[10px] font-bold text-text-muted text-center leading-tight">
                  🤝 Team play: {teamA.map((p) => p.displayName).join(' & ')} vs {teamB.map((p) => p.displayName).join(' & ')} — teammates can't capture each other
                </p>
              );
            })()}

            {justVoided && (
              <div className="bg-error/10 border border-error/30 text-error text-[11px] font-bold text-center rounded-xl py-2 px-3 leading-tight">
                🎲🎲🎲 Three 6's in a row! {voidNotice?.playerName}'s moves this turn were cancelled — rolling again.
              </div>
            )}

            <div
              className="relative grid bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden mx-auto transition-transform duration-500"
              style={{
                gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)`,
                gridTemplateRows: `repeat(${GRID_SIZE}, 1fr)`,
                aspectRatio: '1',
                width: '100%',
                transform: `rotate(${myRotation}deg)`,
              }}
            >
              {COLORS.map((slot) => (
                <YardPanel key={slot} slot={slot} color={slotColors[slot]} />
              ))}

              <CenterTriangle slotColors={slotColors} />

              {Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, idx) => {
                const row = Math.floor(idx / GRID_SIZE);
                const col = idx % GRID_SIZE;
                const key = `${row},${col}`;

                // Yards and the center 3x3 are rendered as their own spanning elements above —
                // skip per-cell rendering for the coordinates they cover.
                if (COLORS.some((c) => {
                  const { rows, cols } = YARD_SPANS[c];
                  return row >= rows[0] && row <= rows[1] && col >= cols[0] && col <= cols[1];
                })) return null;
                if (
                  row >= 6 && row <= 8 && col >= 6 && col <= 8 &&
                  !CORNER_CELLS.some(([r, c]) => r === row && c === col) &&
                  !FINAL_STRETCH_CELLS.some(([r, c]) => r === row && c === col)
                ) return null;

                // Each color's private final run-in lane, tinted to match that color (was plain
                // white before, indistinguishable from ordinary track cells).
                const homeStretchSlot = COLORS.find((c) => HOME_STRETCH_CELLS[c].some(([r, cc]) => r === row && cc === col));
                const homeStretchColor = homeStretchSlot ? slotColors[homeStretchSlot] : undefined;
                const safe = SAFE_CELL_KEYS.has(key);

                return (
                  <div
                    key={idx}
                    className="flex items-center justify-center border border-border-subtle/40"
                    style={{ gridColumn: col + 1, gridRow: row + 1, backgroundColor: homeStretchColor ? `${COLOR_HEX[homeStretchColor]}26` : '#fff' }}
                  >
                    {/* Always rendered (not just when the cell is empty) — a token landing on a
                        star should never make the star itself disappear, it just sits on top of
                        it, same as a real board. */}
                    {safe && <span className="material-symbols-outlined text-[12px] text-primary/60">star</span>}
                  </div>
                );
              })}

              {/* Token overlay — one continuous element per token so CSS can smoothly slide it
                  between cells instead of unmounting/remounting into a new grid cell each hop
                  (mirrors Business's PawnToken overlay). */}
              {players.flatMap((p) =>
                p.tokens.map((pos, tokenIndex) => {
                  const tKey = `${p.uid}:${tokenIndex}`;
                  const dp = displayPositions[tKey] ?? tokenGridPosition(boardSlot(p.seatIndex, players.length), tokenIndex, pos);
                  return { tKey, color: p.color, tokenIndex, dp };
                }),
              ).map((t, _i, arr) => {
                const groupKey = `${t.dp.row.toFixed(1)},${t.dp.col.toFixed(1)}`;
                const group = arr.filter((o) => `${o.dp.row.toFixed(1)},${o.dp.col.toFixed(1)}` === groupKey);
                const idxInGroup = group.findIndex((o) => o.tKey === t.tKey);
                const offsetX = group.length > 1 ? (idxInGroup % 2) * 7 - 3.5 : 0;
                const offsetY = group.length > 1 ? Math.floor(idxInGroup / 2) * 7 - 3.5 : 0;
                // Yard slots (see yardSlotFrac) already resolve to the exact board-fraction center
                // of their dashed placeholder circle — unlike every other case here (PATH52/home-
                // stretch cell indices, which are top-left corners and need +0.5 to reach a cell's
                // center), so adding +0.5 again for a yard token overshoots by half a cell and
                // visibly misaligns it from its circle. `dp.isYard` (not the token's live position)
                // decides this, so it can never disagree with what `dp` itself actually contains.
                const cellCol = t.dp.isYard ? t.dp.col : t.dp.col + 0.5;
                const cellRow = t.dp.isYard ? t.dp.row : t.dp.row + 0.5;
                // A single click on this token's button in "Your Tokens" below (see
                // handleTokenButtonClick) blows it way up right here on the board and pops it
                // above every other token — the direct fix for tokens becoming unreadably tiny
                // once several stack on the same cell.
                const isSelected = !!myPlayer && t.tKey === `${myPlayer.uid}:${selectedTokenIndex}`;
                const baseSize = t.dp.isYard ? 26 : 13;
                const size = isSelected ? baseSize * 2.2 : baseSize;
                return (
                  <div
                    key={t.tKey}
                    className="absolute pointer-events-none transition-[left,top] duration-500 ease-in-out"
                    style={{
                      left: `calc(${(cellCol / GRID_SIZE) * 100}% + ${offsetX}px)`,
                      top: `calc(${(cellRow / GRID_SIZE) * 100}% + ${offsetY}px)`,
                      transform: 'translate(-50%, -50%)',
                      zIndex: isSelected ? 30 : 10,
                    }}
                  >
                    <div className="relative transition-transform duration-500" style={{ transform: `rotate(${-myRotation}deg)` }}>
                      {isSelected && (
                        <div
                          className="absolute inset-0 rounded-full animate-ping"
                          style={{ backgroundColor: COLOR_HEX[t.color], opacity: 0.35 }}
                        />
                      )}
                      <PawnToken color={COLOR_HEX[t.color]} size={size} />
                      {/* Token number — matches the "Your Tokens" selector's own 1-4 labels, so a
                          token on the board can be identified/tracked without needing to open
                          that panel first. */}
                      <span
                        className="absolute left-1/2 -translate-x-1/2 text-white font-black leading-none"
                        style={{
                          top: t.dp.isYard ? '30%' : '22%',
                          fontSize: (t.dp.isYard ? 9 : 6) * (isSelected ? 1.6 : 1),
                          textShadow: '0 0 1.5px rgba(0,0,0,0.95), 0 0 1px rgba(0,0,0,0.95)',
                        }}
                      >
                        {t.tokenIndex + 1}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Roll/move controls are active-only — the board and tokens above stay visible once
                the game finishes, but there's nothing left to control by then. */}
            {game.status === 'active' && (
            <>
            {/* Dice and the token controller share a row (rather than stacking) so this block
                stays short enough that the fixed-position quick-reaction bar never overlaps
                the tappable token buttons. */}
            <div className="flex items-start gap-2">
              <div className="flex flex-col items-center gap-1.5 shrink-0 w-20">
                <DiceFace value={dice} spinning={rolling} size={40} />
                {/* Rolling now happens via this button, not tapping the die itself — the die
                    stays a plain white cube; this button carries the "whose turn" color instead,
                    visible to every viewer even though only the active player can actually tap it. */}
                <button
                  type="button"
                  onClick={isMyTurn && awaitingRoll && !rolling ? handleRoll : undefined}
                  disabled={!(isMyTurn && awaitingRoll && !rolling)}
                  className={clsx(
                    'w-full py-1.5 rounded-lg text-[10px] font-black text-white uppercase tracking-wide transition-all shadow-sm',
                    isMyTurn && awaitingRoll && !rolling ? 'active:scale-95 cursor-pointer animate-pulse' : 'opacity-50 cursor-default',
                  )}
                  style={{ backgroundColor: COLOR_HEX[players[game.currentTurnSeatIndex]?.color] }}
                >
                  {rolling ? '…' : 'Roll'}
                </button>
                {isMyTurn ? (
                  awaitingRoll ? null : movable.length === 0 ? (
                    <p className="text-[10px] text-text-muted text-center leading-tight">No moves — passing…</p>
                  ) : selectedTokenIndex != null && movable.includes(selectedTokenIndex) ? (
                    <p className="text-[10px] font-bold text-primary text-center leading-tight">Tap again to move</p>
                  ) : (
                    <p className="text-[10px] text-text-muted text-center leading-tight">Pick a token</p>
                  )
                ) : (
                  <p className="text-[10px] text-text-muted text-center leading-tight">
                    Waiting for {players[game.currentTurnSeatIndex]?.displayName}…
                  </p>
                )}
              </div>

              {myPlayer && (
                <div className="flex-1 bg-white rounded-2xl border border-border-subtle p-2.5 min-w-0">
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1.5">
                    Your Tokens {!isMyTurn && <span className="normal-case font-medium opacity-70">— tap to locate</span>}
                  </p>
                  <div className="grid grid-cols-4 gap-1">
                    {myPlayer.tokens.map((pos, i) => (
                      <button
                        key={i}
                        onClick={() => handleTokenButtonClick(i)}
                        className={clsx(
                          'py-1.5 px-0.5 rounded-lg text-[9px] font-bold border-2 transition-all flex flex-col items-center gap-0.5 min-w-0',
                          movable.includes(i) ? 'animate-pulse text-white border-transparent' : 'text-text-muted border-border-subtle',
                          selectedTokenIndex === i && 'ring-2 ring-offset-1 ring-primary scale-105',
                        )}
                        style={movable.includes(i) ? { backgroundColor: COLOR_HEX[myPlayer.color] } : undefined}
                      >
                        <span
                          className={clsx('w-3.5 h-3.5 rounded-full flex items-center justify-center text-[8px] font-black shrink-0', movable.includes(i) ? 'bg-white/25' : 'text-white')}
                          style={!movable.includes(i) ? { backgroundColor: COLOR_HEX[myPlayer.color] } : undefined}
                        >
                          {i + 1}
                        </span>
                        <span className="truncate w-full text-center">{statusLabel(pos)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            </>
            )}

          </>
        )}
      </main>
    </div>
  );
}

// A color's 6x6 yard block — 4 faint placeholder slots marking where that color's tokens sit
// while waiting to leave. Purely decorative now (the actual tokens are the overlay PawnTokens
// above, positioned to land right on these slots) — renders as one spanning grid item rather than
// 36 individual cells.
const YardPanel: React.FC<{ slot: Color; color: Color }> = ({ slot, color }) => {
  const { rows, cols } = YARD_SPANS[slot];
  return (
    <div
      className="flex items-center justify-center p-[10%]"
      style={{ gridColumn: `${cols[0] + 1} / ${cols[1] + 2}`, gridRow: `${rows[0] + 1} / ${rows[1] + 2}`, backgroundColor: COLOR_HEX[color] }}
    >
      <div className="grid grid-cols-2 grid-rows-2 gap-[10%] w-full h-full bg-white rounded-[18%] p-[10%]">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-full w-full h-full border-2 border-dashed opacity-30" style={{ borderColor: COLOR_HEX[color] }} />
        ))}
      </div>
    </div>
  );
};

// The center "home" square — four triangular wedges pointing outward to each arm, purely
// decorative (no track cells live inside it; PATH52/CORNER_CELLS never point here).
function CenterTriangle({ slotColors }: { slotColors: Record<Color, Color> }) {
  return (
    <div className="relative" style={{ gridColumn: '7 / 10', gridRow: '7 / 10' }}>
      <div className="absolute inset-0" style={{ backgroundColor: COLOR_HEX[slotColors.green], clipPath: 'polygon(0 0, 50% 50%, 0 100%)' }} />
      <div className="absolute inset-0" style={{ backgroundColor: COLOR_HEX[slotColors.yellow], clipPath: 'polygon(0 0, 50% 50%, 100% 0)' }} />
      <div className="absolute inset-0" style={{ backgroundColor: COLOR_HEX[slotColors.blue], clipPath: 'polygon(100% 0, 50% 50%, 100% 100%)' }} />
      <div className="absolute inset-0" style={{ backgroundColor: COLOR_HEX[slotColors.red], clipPath: 'polygon(0 100%, 50% 50%, 100% 100%)' }} />
    </div>
  );
}

