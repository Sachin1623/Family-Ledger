import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { doc, updateDoc, collection, query, where, documentId } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { useFriendships } from '../../lib/useFriendships';
import { showGamePointsIfAny } from '../../lib/pointsApi';
import {
  parseCard,
  SUIT_SYMBOL,
  SUIT_RED,
  isPureSequence,
  isValidGroup,
  sortHandForDisplay,
  type RummyGame as RummyGameDoc,
  type Rank,
} from '../../lib/rummy';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { RUMMY_HELP } from '../../lib/gameHelp';
import { ReactionButton, ReactionOverlay, useReactionOverlay } from '../../components/GameReactions';
import { ChatButton, ChatPanel, useGameChat } from '../../components/GameChat';
import { VoiceChatButton, useGameVoice } from '../../components/GameVoiceChat';
import InvitePicker from '../../components/InvitePicker';
import PresenceDot from '../../components/PresenceDot';
import ShareGameButton from '../../components/ShareGameButton';
import Fireworks from '../../components/Fireworks';
import ShareWinButton from '../../components/ShareWinButton';
import { buildWinShare } from '../../lib/winShareImage';
import { useGameTurnPresence } from '../../lib/gameTurnPresence';
import DraggableCard from '../../components/DraggableCard';
import { lockLandscape, unlockOrientation } from '../../lib/screenOrientation';

type SelectionMode = 'none' | 'meld543';

// Hand organization (`handGroups`) is purely local/visual, but a page refresh or the app being
// closed and reopened used to wipe it — annoying mid-hand, since re-sorting a 27-card hand into
// groups is real work. Persisted per game+player in localStorage (same pattern as Dashboard's
// EXPANDED_STORAGE_KEY) so returning to the SAME in-progress game restores exactly how it was
// left; a different game or a fresh deal (different gameId) simply doesn't match this key.
const handGroupsStorageKey = (gameId: string, uid: string) => `familyledger_rummy_handgroups_${gameId}_${uid}`;

function loadStoredHandGroups(gameId: string, uid: string, currentHand: string[]): string[][] {
  try {
    const raw = localStorage.getItem(handGroupsStorageKey(gameId, uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: only restore cards that are genuinely still in hand right now — a discard that
    // happened while this device was closed would otherwise leave a stale card wedged in a
    // restored group forever.
    const handSet = new Set(currentHand);
    return parsed
      .map((g: unknown) => (Array.isArray(g) ? g.filter((c): c is string => typeof c === 'string' && handSet.has(c)) : []))
      .filter((g: string[]) => g.length > 0);
  } catch {
    return [];
  }
}

// A bit of table banter every time someone declares their 5-4-3 and unlocks the second joker —
// `{name}` gets swapped for the declarer's display name. Picked at random per spotting so the
// same table doesn't see the identical line every time.
const JOKER_SPOTTED_LINES = [
  '{name} just spotted the Joker! It looked away nervously. 🃏',
  '{name} found the Joker hiding in plain sight. Sneaky!',
  '{name} has seen the Joker — and the Joker has seen {name} back. 👀',
  'Plot twist: {name} now knows exactly where the Joker is.',
  '{name} unlocked Joker Vision! Achievement: Wildcard Whisperer.',
  'The Joker has been spotted by {name}. Everyone act natural.',
  "{name} peeked behind the curtain. The Joker wasn't ready.",
];

// Same "swallow the value already present on mount, only fire on a genuinely NEW change" pattern
// as useReactionOverlay in GameReactions.tsx — a `lastJokerSpot` from before this screen opened is
// stale, not something to announce right now.
function useJokerSpotted(lastJokerSpot: RummyGameDoc['lastJokerSpot']) {
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const seenAtRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (seenAtRef.current === undefined) {
      seenAtRef.current = lastJokerSpot?.at ?? null;
      return;
    }
    if (!lastJokerSpot || lastJokerSpot.at === seenAtRef.current) return;
    seenAtRef.current = lastJokerSpot.at;

    const line = JOKER_SPOTTED_LINES[Math.floor(Math.random() * JOKER_SPOTTED_LINES.length)];
    const id = Date.now();
    setToast({ id, text: line.replace(/\{name\}/g, lastJokerSpot.displayName) });
    setTimeout(() => setToast((cur) => (cur?.id === id ? null : cur)), 3500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastJokerSpot?.at, lastJokerSpot?.displayName]);

  return toast;
}

// A plain <div> (not <button>) — this needs to nest safely inside OTHER clickable containers
// (e.g. the discard pile's own click target), and nested <button>s are invalid HTML that browsers
// silently repair by closing the outer button early, breaking its click handler.
const CardChip: React.FC<{
  cardId: string;
  selected?: boolean;
  dim?: boolean;
  highlight?: boolean;
  faceDown?: boolean;
  onClick?: () => void;
  // Default (unset) is a HAND card — your own hand grid — sized 25% smaller than this game's
  // original single hand-card size. 'group' is a card sitting inside an organized GroupRow, 15%
  // smaller again than that (so a tile can show more cards before its row needs to scroll —
  // freed-up width matters more there since GroupRow tiles run 2-per-row). 'played' is the
  // discard pile's top card, the only card that's actually left a hand and is now just
  // informational — was 50% smaller than the original size, then bumped 50% bigger again after
  // that read too small in practice, landing at 27x36 (~44% of the original).
  size?: 'played' | 'group';
  // Ranks that currently count as wild FOR THE VIEWER — rank1 is always in here for everyone
  // (public from the start), rank2 only for a player who's personally unlocked the 2nd joker.
  // Marks every matching card with a small joker badge, not just the two revealed indicator cards.
  wildcardRanks?: Rank[];
}> = ({ cardId, selected, dim, highlight, faceDown, onClick, size, wildcardRanks }) => {
  const { rank, suit } = parseCard(cardId);
  const red = SUIT_RED[suit];
  const dims = size === 'played' ? 'w-[27px] h-9 text-[9px]' : size === 'group' ? 'w-[31px] h-[41px] text-[10px]' : 'w-9 h-12 text-[11px]';
  const isWild = !faceDown && !!wildcardRanks?.includes(rank as Rank);
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      className={`relative ${dims} shrink-0 rounded-lg border-2 flex flex-col items-center justify-center font-bold bg-white transition-all ${
        onClick ? 'cursor-pointer' : ''
      } ${
        highlight
          ? 'border-warning ring-2 ring-warning/60 -translate-y-1 shadow-md'
          : selected
          ? 'border-primary -translate-y-2 shadow-md'
          : 'border-border-subtle'
      } ${dim ? 'opacity-40' : ''} ${faceDown ? 'bg-primary text-white' : red ? 'text-error' : 'text-on-surface'}`}
    >
      {isWild && (
        <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-warning text-white flex items-center justify-center shadow">
          <span className="material-symbols-outlined text-[9px] leading-none">auto_awesome</span>
        </span>
      )}
      {faceDown ? (
        <span className="material-symbols-outlined rotate-180 text-[18px]">style</span>
      ) : (
        <>
          <span>{rank}</span>
          <span className="text-base leading-none">{SUIT_SYMBOL[suit]}</span>
        </>
      )}
    </div>
  );
};

// A card as it looks on the felt table (same look as 13-Card Rummy): `table` = lying on the table
// (discard / jokers / draw deck), `fan` = in the hand row, where cards overlap so only the top-left
// corner (rank + suit) stays visible under the next card.
const TableCard: React.FC<{
  cardId: string;
  selected?: boolean;
  dim?: boolean;
  highlight?: boolean;
  faceDown?: boolean;
  onClick?: () => void;
  size?: 'table' | 'fan';
  wildcardRanks?: string[];
}> = ({ cardId, selected, dim, highlight, faceDown, onClick, size = 'table', wildcardRanks }) => {
  const { rank, suit } = parseCard(cardId);
  const red = SUIT_RED[suit];
  const corner = size === 'fan';
  const dims = corner
    ? 'w-[min(15vw,3.75rem)] landscape:w-[min(9vw,17vh,3.75rem)] aspect-[5/7] text-sm pl-1 pt-0.5'
    : 'w-[min(14vw,3.75rem)] landscape:w-[min(14vh,3.25rem)] aspect-[5/7] text-sm';
  const isWild = !faceDown && !!wildcardRanks?.includes(rank as Rank);
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      className={`relative ${dims} shrink-0 rounded-lg border-2 flex flex-col ${corner && !faceDown ? 'items-start justify-start' : 'items-center justify-center'} font-bold bg-white transition-all ${
        onClick ? 'cursor-pointer active:scale-95' : ''
      } ${
        selected
          ? 'border-primary ring-2 ring-primary/70 shadow-md bg-primary/10'
          : highlight
          ? 'border-warning ring-2 ring-warning/60 shadow-md'
          : 'border-border-subtle'
      } ${dim ? 'opacity-40' : ''} ${faceDown ? 'bg-primary text-white border-white ring-1 ring-inset ring-white/50 [background-image:repeating-linear-gradient(45deg,rgba(255,255,255,0.14)_0_5px,transparent_5px_10px)]' : red ? 'text-error' : 'text-on-surface'}`}
    >
      {isWild && !corner && (
        <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-warning text-white flex items-center justify-center shadow">
          <span className="material-symbols-outlined text-[9px] leading-none">auto_awesome</span>
        </span>
      )}
      {faceDown ? (
        <span className="material-symbols-outlined rotate-180 text-[26px]">style</span>
      ) : (
        <>
          <span className="leading-none">{rank}</span>
          <span className="text-xl leading-none">{SUIT_SYMBOL[suit]}</span>
          {isWild && corner && (
            <span className="mt-0.5 w-4 h-4 rounded-full bg-warning text-white flex items-center justify-center shadow shrink-0">
              <span className="material-symbols-outlined text-[11px] leading-none">auto_awesome</span>
            </span>
          )}
        </>
      )}
    </div>
  );
};

const GroupRow: React.FC<{
  cardIds: string[];
  valid?: boolean;
  label?: string;
  onRemove?: () => void;
  onCardClick?: (id: string) => void;
  selectedIds?: string[];
  highlightId?: string | null;
  onAddSelected?: () => void;
  addSelectedCount?: number;
  wildcardRanks?: Rank[];
}> = ({ cardIds, valid, label, onRemove, onCardClick, selectedIds, highlightId, onAddSelected, addSelectedCount, wildcardRanks }) => {
  return (
    <div className={`relative p-1.5 rounded-lg border ${valid ? 'border-success bg-success/5' : 'border-border-subtle bg-surface'}`}>
      {label && <span className="text-[10px] font-bold text-text-muted uppercase block mb-1">{label}</span>}
      {/* Add/Remove as small corner badges, absolutely positioned and slightly overhanging the
          tile's own border — NOT in normal flow, so they can never add to the tile's height (they
          used to sit in their own control row above the cards, which did). */}
      {onRemove && (
        <button
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 z-10 w-5 h-5 rounded-full bg-white border border-border-subtle shadow flex items-center justify-center text-text-muted"
        >
          <span className="material-symbols-outlined text-[13px] leading-none">close</span>
        </button>
      )}
      {onAddSelected && (
        <button
          onClick={onAddSelected}
          className="absolute -bottom-1.5 -right-1.5 z-10 flex items-center gap-0.5 h-5 min-w-[20px] px-1 rounded-full bg-primary text-white text-[10px] font-black shadow"
        >
          <span className="material-symbols-outlined text-[12px] leading-none">add</span>
          {addSelectedCount ? addSelectedCount : ''}
        </button>
      )}
      <div className="flex gap-1 overflow-x-auto">
        {cardIds.map((c, idx) => (
          <CardChip
            key={`${c}-${idx}`}
            cardId={c}
            size="group"
            selected={selectedIds?.includes(c)}
            highlight={c === highlightId}
            onClick={onCardClick ? () => onCardClick(c) : undefined}
            wildcardRanks={wildcardRanks}
          />
        ))}
      </div>
    </div>
  );
};

export default function RummyGame() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { friendCandidates } = useFriendships(user?.uid);

  const [gameSnap, loading] = useDocument(gameId ? doc(db, 'rummyGames', gameId) : null);
  const game = gameSnap?.exists() ? (gameSnap.data() as RummyGameDoc) : null;
  const voice = useGameVoice('rummyGames', gameId, game?.players || []);

  // Points are awarded inline, server-side, the moment the game's finish transaction commits —
  // this just triggers every player's OWN flying-coins animation once their client notices the
  // finish (deduped per gameId so a re-render never re-triggers it).
  const shownRummyPointsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!gameId || !user || game?.status !== 'finished') return;
    if (shownRummyPointsRef.current.has(gameId)) return;
    shownRummyPointsRef.current.add(gameId);
    showGamePointsIfAny('rummy', gameId);
  }, [gameId, user, game?.status]);

  // "It's your turn" presence — lets the server skip notifying this user while they're actually
  // looking at this exact game (see notifyGameTurn in server.ts, called from /api/rummy/discard
  // and /api/rummy/drop).
  useGameTurnPresence('rummy', gameId);

  const floatingReactions = useReactionOverlay(game?.lastReaction);
  const jokerToast = useJokerSpotted(game?.lastJokerSpot);
  const handleSendReaction = async (emoji: string) => {
    if (!user || !gameId) return;
    try {
      const idToken = await user.getIdToken();
      await fetch('/api/games/react', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameType: 'rummy', gameId, emoji }),
      });
    } catch (err) {
      console.error('Failed to send reaction:', err);
    }
  };

  // A card leaving the hand only ever happens via discard/draw — nothing a player declares
  // (5-4-3 for the joker, or the win itself) ever removes cards server-side, so `cards` is the
  // complete, always-current hand with no separate "melded/locked" subset to track.
  const [handSnap] = useDocument(
    gameId && user && game?.status === 'active' ? doc(db, 'rummyGames', gameId, 'hands', user.uid) : null,
  );
  const handCards: string[] = handSnap?.exists() ? (handSnap.data().cards || []) : [];
  const handSorted = useMemo(() => sortHandForDisplay(handCards), [handCards]);

  const [groupsMembersValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = groupsMembersValue?.docs.map((d) => d.data().groupId) || [];
  const [showInvite, setShowInvite] = useState(false);

  const { messages: chatMessages, loading: chatLoading, hasUnseen: chatUnseen, markSeen: markChatSeen } = useGameChat('rummyGames', gameId);
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

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [mode, setMode] = useState<SelectionMode>('none');
  const [meldSlots, setMeldSlots] = useState<{ five: string[]; four: string[]; three: string[] }>({ five: [], four: [], three: [] });
  // Purely local/visual — lets a player freely arrange their hand into any number of tentative
  // groups for their own reference (not synced anywhere, not validated by the server). Always
  // active whenever no other action is in progress (mode === 'none'), so organizing never needs
  // its own separate toggled mode. Declare Win reads directly from this: the moment everything is
  // grouped except exactly one card, and a 5/4/3 pure-sequence triple exists among the groups,
  // winning is one tap away — no separate win-declare wizard.
  const [handGroups, setHandGroups] = useState<string[][]>([]);
  const [selectedForGroup, setSelectedForGroup] = useState<string[]>([]);
  // The card most recently drawn this turn — highlighted in the hand until the turn changes hands.
  const [lastDrawnCard, setLastDrawnCard] = useState<string | null>(null);
  // Drag-to-discard: the felt table is the drop target; isDraggingCard lights it up while a card is held.
  const tableDropRef = useRef<HTMLDivElement>(null);
  const [isDraggingCard, setIsDraggingCard] = useState(false);
  // True from the moment a card starts moving until just after release, so the click the browser
  // fires at the end of a drag is never mistaken for a tap-to-select.
  const cardWasDragged = useRef(false);
  // "Turn your phone" prompt shown while held upright; the player can wave it away for this session.
  const [portraitHintDismissed, setPortraitHintDismissed] = useState(false);
  const [showExitMenu, setShowExitMenu] = useState(false);

  // Played sideways by default: lock to landscape while a game is in progress, release on the way out.
  const gameIsActive = game?.status === 'active';
  useEffect(() => {
    if (!gameIsActive) return;
    lockLandscape();
    return () => { unlockOrientation(); };
  }, [gameIsActive]);

  // Current profile photos for everyone seated (the photo saved on the game when someone sat down can
  // be empty or out of date).
  const humanUids = useMemo(() => (game?.players || []).filter((p) => !p.isBot).map((p) => p.uid), [game?.players]);
  const [playerUsersValue] = useCollection(
    humanUids.length > 0 ? query(collection(db, 'users'), where(documentId(), 'in', humanUids.slice(0, 30))) : null,
  );
  const photoByUid = useMemo(() => {
    const m: Record<string, string> = {};
    playerUsersValue?.docs.forEach((d) => {
      const photo = (d.data() as any).photoURL;
      if (photo) m[d.id] = photo;
    });
    return m;
  }, [playerUsersValue]);

  // Restores `handGroups` from localStorage the first moment a real hand is available (waits for
  // `handCards.length > 0` rather than firing on mount, since the hand doc hasn't loaded yet at
  // that point and filtering against an empty hand would discard everything). Runs once per
  // gameId — `hydratedRef` guards against re-firing on every subsequent hand update.
  const hydratedGroupsRef = useRef(false);
  useEffect(() => {
    hydratedGroupsRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);
  useEffect(() => {
    if (hydratedGroupsRef.current || !gameId || !user || handCards.length === 0) return;
    hydratedGroupsRef.current = true;
    const stored = loadStoredHandGroups(gameId, user.uid, handCards);
    if (stored.length > 0) setHandGroups(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, user, handCards.length]);

  // Persists on every change, once hydration has happened (so the initial empty state doesn't
  // momentarily overwrite whatever was already stored before the real hand loads in).
  useEffect(() => {
    if (!hydratedGroupsRef.current || !gameId || !user) return;
    try {
      localStorage.setItem(handGroupsStorageKey(gameId, user.uid), JSON.stringify(handGroups));
    } catch {
      // localStorage unavailable (private browsing etc.) — organization just won't persist.
    }
  }, [handGroups, gameId, user]);

  // Also synced to Firestore (debounced, and only while the game is still active) — purely so the
  // post-game reveal screen can show a losing/eliminated player's hand the way they'd actually
  // arranged it, not because gameplay itself ever reads this back. Only the `groups` field on a
  // hand doc is client-writable at all — see firestore.rules — `cards` stays Admin-SDK-only.
  const groupsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hydratedGroupsRef.current || !gameId || !user || game?.status !== 'active') return;
    if (groupsSyncTimerRef.current) clearTimeout(groupsSyncTimerRef.current);
    groupsSyncTimerRef.current = setTimeout(() => {
      // Firestore rejects arrays nested directly inside arrays — handGroups is string[][], so
      // each group gets wrapped in a single-key object to store as an array of maps instead (see
      // server.ts's matching comment on the reveal-side of this same field).
      updateDoc(doc(db, 'rummyGames', gameId, 'hands', user.uid), { groups: handGroups.map((g) => ({ cards: g })) }).catch(() => {
        // Best-effort — a failed sync just means the reveal screen falls back to an ungrouped hand.
      });
    }, 800);
    return () => { if (groupsSyncTimerRef.current) clearTimeout(groupsSyncTimerRef.current); };
  }, [handGroups, gameId, user, game?.status]);

  const resetSelections = () => {
    setMode('none');
    setMeldSlots({ five: [], four: [], three: [] });
    setSelectedForGroup([]);
    setError(null);
  };

  const enterMode = (m: SelectionMode) => {
    resetSelections();
    setMode(m);
  };

  // Finds already-organized groups that are exactly the right size and shape (5/4/3, pure
  // sequences) to pre-fill a 5-4-3 declaration directly from however the hand's been arranged.
  const prefill543FromGroups = (groups: string[][]): { five: string[]; four: string[]; three: string[] } => {
    const bySize = (size: number) => groups.find((g) => g.length === size && isPureSequence(g)) || [];
    return { five: bySize(5), four: bySize(4), three: bySize(3) };
  };

  const handleEnterMeld543 = () => {
    resetSelections();
    setMeldSlots(prefill543FromGroups(handGroups));
    setMode('meld543');
  };

  // Clears the "just drawn" highlight the instant the turn actually moves on (i.e. the current
  // player discards) — not on every render, so it survives the draw→discard phase transition
  // within the same turn.
  useEffect(() => {
    setLastDrawnCard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.currentTurnSeatIndex, gameId]);

  const call = async (path: string, body: Record<string, unknown>) => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, ...body }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Request failed.');
      return json;
    } catch (err: any) {
      setError(err.message || 'Something went wrong.');
      throw err;
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="p-8 text-center text-text-muted">Loading…</div>;
  if (!game || !user) return <div className="p-8 text-center text-text-muted">Game not found.</div>;

  const myIndex = game.players.findIndex((p) => p.uid === user.uid);
  const me = myIndex >= 0 ? game.players[myIndex] : null;
  const isPlayer = !!me;
  const isMyTurn = game.status === 'active' && game.players[game.currentTurnSeatIndex]?.uid === user.uid;
  const wildcardRanks: Rank[] = (me?.hasSecondJoker ? [game.wildcardRank1, game.wildcardRank2] : [game.wildcardRank1]).filter(
    Boolean,
  ) as Rank[];

  // Joining by code only ever navigates here (see RummyLobby.tsx) — actually adding the joiner to
  // the game's players/playerUids happens on arrival, same pattern as LudoGame.tsx's handleJoin.
  const handleJoinGame = async () => {
    if (!user || isPlayer || game.players.length >= 4) return;
    setError(null);
    try {
      const newPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: game.players.length,
        handCount: 0,
        hasSecondJoker: false,
        pureRun543At: null,
        dropped: false,
      };
      await updateDoc(doc(db, 'rummyGames', gameId!), {
        players: [...game.players, newPlayer],
        playerUids: [...game.playerUids, user.uid],
      });
    } catch (err) {
      console.error('Failed to join Rummy game:', err);
      setError('Failed to join — the game may already be full or started.');
    }
  };

  const handleInvite = async (inviteeUids: string[], poke = false) => {
    if (!user || inviteeUids.length === 0) return;
    const idToken = await user.getIdToken();
    await fetch('/api/rummy/invite', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, inviteeUids, poke }),
    }).catch((err) => console.error('rummy invite failed:', err));
    if (!poke) setShowInvite(false);
  };

  const handleStart = async () => {
    await call('/api/rummy/start', {}).catch(() => {});
  };

  const handleFillBot = async () => {
    await call('/api/rummy/fill-bot', {}).catch(() => {});
  };

  const handleCopyCode = () => {
    navigator.clipboard?.writeText(game.code).catch(() => {});
  };

  const handleDrawStock = () =>
    call('/api/rummy/draw', { source: 'stock' })
      .then((json) => setLastDrawnCard(json?.drawnCard || null))
      .catch(() => {});
  const handleDrawDiscard = () =>
    call('/api/rummy/draw', { source: 'discard' })
      .then((json) => setLastDrawnCard(json?.drawnCard || null))
      .catch(() => {});

  // Discarding is just: select a card (the same tap used for organizing), then tap this — 2 taps
  // total, no separate "enter discard mode" step first. Works the same whether the card is loose
  // or currently sitting in an organize group.
  const handleQuickDiscard = async (cardId: string) => {
    await call('/api/rummy/discard', { cardId }).catch(() => {});
    setHandGroups((gs) => gs.map((g) => g.filter((c) => c !== cardId)).filter((g) => g.length > 0));
    setSelectedForGroup([]);
  };

  const handleMeldTap = (cardId: string) => {
    setMeldSlots((prev) => {
      const inFive = prev.five.includes(cardId);
      const inFour = prev.four.includes(cardId);
      const inThree = prev.three.includes(cardId);
      if (inFive) return { ...prev, five: prev.five.filter((c) => c !== cardId) };
      if (inFour) return { ...prev, four: prev.four.filter((c) => c !== cardId) };
      if (inThree) return { ...prev, three: prev.three.filter((c) => c !== cardId) };
      if (prev.five.length < 5) return { ...prev, five: [...prev.five, cardId] };
      if (prev.four.length < 4) return { ...prev, four: [...prev.four, cardId] };
      if (prev.three.length < 3) return { ...prev, three: [...prev.three, cardId] };
      return prev;
    });
  };

  const meldReady = meldSlots.five.length === 5 && meldSlots.four.length === 4 && meldSlots.three.length === 3;
  const meldValid =
    meldReady && isPureSequence(meldSlots.five) && isPureSequence(meldSlots.four) && isPureSequence(meldSlots.three);

  // Only ever unlocks the 2nd joker — the 12 named cards are never removed from the hand, so this
  // never touches `handCards`/`handGroups` at all.
  const handleMeldSubmit = async () => {
    await call('/api/rummy/declare-543', meldSlots).catch(() => {});
    resetSelections();
  };

  // Win declaration now reads directly from however the hand is currently organized via "Group
  // Cards" — no separate wizard. Exactly one card must be left ungrouped (the finishing discard),
  // and among the groups there must be a genuine 5-run, 4-run, and 3-run pure sequence (the
  // mandatory shape) — declaring 5-4-3 earlier never locked those cards away, so the same ones (or
  // different ones) can be reused here freely. Whichever matching groups happen to exist fill the
  // mandatory slots; everything else just rides along as a regular group.
  const looseForWin = handSorted.filter((c) => !handGroups.some((g) => g.includes(c)));
  const mandatoryFive = handGroups.find((g) => g.length === 5 && isPureSequence(g)) || null;
  const mandatoryFour = handGroups.find((g) => g.length === 4 && isPureSequence(g) && g !== mandatoryFive) || null;
  const mandatoryThree =
    handGroups.find((g) => g.length === 3 && isPureSequence(g) && g !== mandatoryFive && g !== mandatoryFour) || null;
  const otherGroupsForWin = handGroups.filter((g) => g !== mandatoryFive && g !== mandatoryFour && g !== mandatoryThree);
  const allGroupsValidForWin = handGroups.every((g) => isValidGroup(g, wildcardRanks).valid);
  const canDeclareWinNow =
    isMyTurn &&
    !me?.dropped &&
    game.turnPhase === 'discard' &&
    mode === 'none' &&
    looseForWin.length === 1 &&
    !!mandatoryFive &&
    !!mandatoryFour &&
    !!mandatoryThree &&
    allGroupsValidForWin;

  const handleDeclareWinNow = async () => {
    if (!canDeclareWinNow || !mandatoryFive || !mandatoryFour || !mandatoryThree) return;
    await call('/api/rummy/declare-win', {
      discardCardId: looseForWin[0],
      five: mandatoryFive,
      four: mandatoryFour,
      three: mandatoryThree,
      groups: otherGroupsForWin,
    }).catch(() => {});
    // A win clears the game to 'finished' via the live listener; an incorrect declaration drops
    // this player server-side — either way there's nothing further to reconcile in local state.
  };

  const handleDrop = async () => {
    if (!window.confirm('Drop out of this game? You cannot rejoin.')) return;
    await call('/api/rummy/drop', {}).catch(() => {});
  };

  // Host-only, and only while the game hasn't started (or is already over) — an active game has
  // other players mid-match, so the server rejects deleting it (they should Drop instead).
  const handleDeleteGame = async () => {
    if (!window.confirm('Delete this game? This cannot be undone.')) return;
    try {
      await call('/api/rummy/delete', {});
      navigate('/games/rummy');
    } catch {
      // error already surfaced via `error` state
    }
  };

  // Any player on the finished screen can trigger this, not just the original host — a rematch
  // with the same players, no re-inviting needed. If someone else already started it, the server
  // just hands back that same game id instead of creating a duplicate.
  const handlePlayAgain = async () => {
    try {
      const json = await call('/api/rummy/rematch', {});
      if (json?.gameId) navigate(`/games/rummy/${json.gameId}`);
    } catch {
      // error already surfaced via `error` state
    }
  };

  // Organize — purely local arrangement, independent of turn/phase, always active whenever no
  // other action is underway. Any card can be selected regardless of whether it's currently loose
  // or already sitting in a group, which is what makes this flexible: selecting cards spread
  // across several existing groups (plus loose ones) and hitting "Group Selected" merges all of
  // them into one new group, pulling each out of wherever it was; selecting cards and hitting
  // "Ungroup Selected" instead just returns them to the loose pool. Together that covers forming
  // new groups, merging groups, splitting a group, and moving individual cards between groups —
  // without needing a dedicated drag-and-drop implementation.
  const toggleForGroup = (c: string) => setSelectedForGroup((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));

  const handleGroupSelected = () => {
    if (selectedForGroup.length < 2) return;
    setHandGroups((gs) => {
      const stripped = gs.map((g) => g.filter((c) => !selectedForGroup.includes(c))).filter((g) => g.length > 0);
      return [...stripped, selectedForGroup];
    });
    setSelectedForGroup([]);
  };

  const canUngroupSelected = selectedForGroup.some((c) => handGroups.some((g) => g.includes(c)));
  const handleUngroupSelected = () => {
    setHandGroups((gs) => gs.map((g) => g.filter((c) => !selectedForGroup.includes(c))).filter((g) => g.length > 0));
    setSelectedForGroup([]);
  };

  // The direct "add to an existing group" affordance — each GroupRow gets its own "+" button so a
  // player doesn't have to reselect that whole group's existing members just to drop one more card
  // in (which is all the general Group Selected/Ungroup Selected pair above supports on their own).
  const handleAddSelectedToGroup = (groupIdx: number) => {
    if (selectedForGroup.length === 0) return;
    setHandGroups((gs) => {
      const withoutSelectedElsewhere = gs.map((g, i) => (i === groupIdx ? g : g.filter((c) => !selectedForGroup.includes(c))));
      const targetExisting = withoutSelectedElsewhere[groupIdx].filter((c) => !selectedForGroup.includes(c));
      const merged = withoutSelectedElsewhere.map((g, i) => (i === groupIdx ? [...targetExisting, ...selectedForGroup] : g));
      return merged.filter((g) => g.length > 0);
    });
    setSelectedForGroup([]);
  };

  // A single tap-interaction resolver reused everywhere a card can appear (the flat hand grid AND
  // inside an organize group row), so a card behaves identically no matter which row it's showing
  // in for the currently active mode.
  const getCardInteraction = (c: string): { selected: boolean; onClick?: () => void } => {
    if (mode === 'meld543') {
      return {
        selected: meldSlots.five.includes(c) || meldSlots.four.includes(c) || meldSlots.three.includes(c),
        onClick: () => handleMeldTap(c),
      };
    }
    // mode === 'none': always-on organize — tap any card, loose or already grouped, to select it.
    return { selected: selectedForGroup.includes(c), onClick: !me?.dropped ? () => toggleForGroup(c) : undefined };
  };

  // Your organized groups stay visible and tappable in EVERY mode, not just while idle — picking a
  // card to discard or filling a 5-4-3 slot should never require your organization to disappear
  // first.
  const visibleHandGroups = handGroups.map((g, idx) => ({ idx, cards: g })).filter((entry) => entry.cards.length > 0);
  const groupedCardIds = new Set(handGroups.flat());
  const handGridCards = handSorted.filter((c) => !groupedCardIds.has(c));

  // ---- Waiting room ----
  if (game.status === 'waiting') {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <ReactionOverlay reactions={floatingReactions} />
        <header className="p-4 flex items-center gap-3 bg-white border-b border-border-subtle">
          <h1 className="font-black text-primary">27-Hand Rummy</h1>
          <ReactionButton onSend={handleSendReaction} />
          <div className="flex items-center gap-1 ml-auto">
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
          {showHelp && <GameHelpModal content={RUMMY_HELP} onClose={() => setShowHelp(false)} />}
        </header>
        {showChat && user && (
          <ChatPanel
            collectionName="rummyGames"
            gameId={gameId!}
            messages={chatMessages}
            loading={chatLoading}
            myUid={user.uid}
            myDisplayName={profile?.displayName || user.displayName || 'Player'}
            myPhotoURL={profile?.photoURL || user.photoURL || ''}
            otherUids={game.players.filter((p) => p.uid !== user.uid).map((p) => p.uid)}
            onClose={() => setShowChat(false)}
          />
        )}
        <main className="flex-1 p-4 max-w-xl mx-auto w-full space-y-5 pb-24">
          <div className="bg-white rounded-2xl border border-border-subtle p-5 flex items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Share code</p>
              <p className="text-2xl font-black text-primary tracking-widest">{game.code}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={handleCopyCode} className="px-3 py-2 bg-primary/10 text-primary rounded-xl text-xs font-bold flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">content_copy</span> Copy
              </button>
              <ShareGameButton
                gameLabel="27-Hand Rummy"
                code={game.code}
                path={`/games/rummy/${gameId}`}
                className="px-3 py-2 bg-[#25D366] text-white rounded-xl text-xs font-bold flex items-center gap-1"
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
            {game.players.map((p) => (
              <div key={p.uid} className="p-4 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold overflow-hidden">
                  {p.isBot ? '🤖' : p.photoURL ? (
                    <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    p.displayName?.slice(0, 1) || '?'
                  )}
                </div>
                <p className="text-sm font-bold text-on-surface">{p.displayName}</p>
                {p.uid === game.hostUid && <span className="ml-auto text-[10px] font-bold text-primary uppercase">Host</span>}
              </div>
            ))}
            {Array.from({ length: Math.max(0, 2 - game.players.length) }).map((_, i) => (
              <div key={i} className="p-4 flex items-center gap-3 opacity-40">
                <div className="w-9 h-9 rounded-full border-2 border-dashed border-border-subtle" />
                <p className="text-sm text-text-muted italic">Waiting for player…</p>
              </div>
            ))}
          </div>

          {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

          {!isPlayer && game.players.length < 4 && (
            <button onClick={handleJoinGame} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">
              Join Game
            </button>
          )}

          {isPlayer && (
            <button
              onClick={() => setShowInvite((v) => !v)}
              className="w-full py-2.5 border border-border-subtle text-primary font-bold rounded-xl text-sm flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-[18px]">group_add</span>
              Invite Group Members
            </button>
          )}

          {showInvite && (
            <InvitePicker groupIds={groupIds} alreadyIn={game.players.map((p) => p.uid)} onInvite={handleInvite} extraCandidates={friendCandidates} />
          )}

          {isPlayer && user.uid === game.hostUid && game.players.length < 4 && (
            <button
              onClick={handleFillBot}
              disabled={busy}
              className="w-full py-2.5 border border-border-subtle text-text-muted font-bold rounded-xl text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">smart_toy</span>
              Fill Empty Seat with Bot
            </button>
          )}

          {isPlayer && user.uid === game.hostUid ? (
            <button
              onClick={handleStart}
              disabled={busy || game.players.length < 2}
              className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
            >
              {game.players.length < 2 ? 'Need at least 2 players' : busy ? 'Starting…' : 'Start Game'}
            </button>
          ) : isPlayer ? (
            <p className="text-center text-sm text-text-muted italic">Waiting for the host to start the game…</p>
          ) : null}

          {isPlayer && user.uid === game.hostUid && (
            <button onClick={handleDeleteGame} className="w-full py-2.5 text-error/70 font-bold text-sm">
              Delete Game
            </button>
          )}
        </main>
      </div>
    );
  }

  // ---- Finished ----
  if (game.status === 'finished') {
    const winner = game.players.find((p) => p.uid === game.winnerUid);
    const revealWildcardRanks = [game.wildcardRank1, game.wildcardRank2].filter(Boolean) as Rank[];
    const winShare = winner && winner.uid === user.uid
      ? buildWinShare({
          gameName: '27-Hand Rummy',
          winnerLabel: winner.displayName,
          standings: [...game.players]
            .sort((a, b) => Number(b.uid === game.winnerUid) - Number(a.uid === game.winnerUid))
            .map((p) => ({ name: p.displayName, label: p.uid === game.winnerUid ? 'Winner' : p.dropped ? 'Dropped' : undefined, isWinner: p.uid === game.winnerUid })),
          detail: `${game.players.length}-player table`,
        })
      : null;
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <ReactionOverlay reactions={floatingReactions} />

        {/* Winner banner — fixed height, never grows, so it can never eat into the card-reveal
            area below it regardless of name length or player count. The rematch/lobby actions
            live right here (not a bottom bar) so they're immediately visible the moment the
            screen opens, with zero chance of ever covering the card reveal below. */}
        <div className="relative shrink-0 bg-primary/5 border-b border-border-subtle px-4 py-4 text-center overflow-hidden">
          <Fireworks />
          <span className="relative text-4xl">🏆</span>
          <div className="relative flex items-center justify-center gap-2 mt-1">
            <h1 className="text-lg font-black text-primary">{winner ? `${winner.displayName} wins!` : 'Game over'}</h1>
            <ReactionButton onSend={handleSendReaction} />
          </div>
          {error && <p className="relative text-xs font-bold text-error mt-1">{error}</p>}
          {winShare && <ShareWinButton card={winShare.card} caption={winShare.caption} className="relative mt-3" />}
          <div className="relative flex items-center gap-2 mt-3">
            {isPlayer && (
              <button
                onClick={() => (game.rematchGameId ? navigate(`/games/rummy/${game.rematchGameId}`) : handlePlayAgain())}
                disabled={busy}
                className="flex-1 py-2.5 bg-success text-white font-bold rounded-2xl disabled:opacity-50 text-sm"
              >
                {game.rematchGameId ? 'Join Rematch' : busy ? 'Starting…' : 'Play Again'}
              </button>
            )}
            <button onClick={() => navigate('/tools?category=games')} className="flex-1 py-2.5 bg-primary text-white font-bold rounded-2xl text-sm">
              Back to Games
            </button>
            {user.uid === game.hostUid && (
              <button onClick={handleDeleteGame} className="p-2.5 bg-white rounded-2xl border border-border-subtle text-error/70 shrink-0" aria-label="Delete game">
                <span className="material-symbols-outlined text-[20px] block">delete</span>
              </button>
            )}
          </div>
        </div>

        {/* Everyone's revealed hand — the only scrolling region, so the winner banner above stays
            put while this scrolls underneath it. */}
        <main className="flex-1 overflow-y-auto p-4 space-y-4">
          {game.players.map((p) => {
            const revealed = game.revealedHands?.[p.uid];
            const isWinner = p.uid === game.winnerUid;
            return (
              <div key={p.uid} className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-black ${isWinner ? 'text-success' : 'text-on-surface'}`}>
                    {isWinner ? '🏆 ' : ''}{p.displayName}
                    {p.uid === user.uid ? ' (You)' : ''}
                  </span>
                  {p.dropped && !isWinner && <span className="text-[10px] font-bold text-text-muted uppercase">dropped</span>}
                </div>
                {!revealed ? (
                  <p className="text-xs text-text-muted italic">Hand not available.</p>
                ) : revealed.melds ? (
                  <div className="space-y-1.5">
                    <GroupRow cardIds={revealed.melds.five} valid label="Pure Run (5)" wildcardRanks={revealWildcardRanks} />
                    <GroupRow cardIds={revealed.melds.four} valid label="Pure Run (4)" wildcardRanks={revealWildcardRanks} />
                    <GroupRow cardIds={revealed.melds.three} valid label="Pure Run (3)" wildcardRanks={revealWildcardRanks} />
                    {revealed.melds.groups.map((g, i) => (
                      <GroupRow key={i} cardIds={g.cards} valid label={`Group ${i + 1}`} wildcardRanks={revealWildcardRanks} />
                    ))}
                    <GroupRow cardIds={[revealed.melds.discardCardId]} label="Discarded to Win" wildcardRanks={revealWildcardRanks} />
                  </div>
                ) : (
                  (() => {
                    // Non-winners never validated a meld, but they may well have organized their
                    // own hand while playing (`groups`, synced from their own client) — show it
                    // exactly as they'd arranged it rather than flattening it into one row.
                    const groupedCards = new Set((revealed.groups || []).flatMap((g) => g.cards));
                    const ungrouped = revealed.cards.filter((c) => !groupedCards.has(c));
                    const hasGroups = (revealed.groups || []).some((g) => g.cards.length > 0);
                    return hasGroups ? (
                      <div className="space-y-1.5">
                        {(revealed.groups || []).filter((g) => g.cards.length > 0).map((g, i) => (
                          <GroupRow key={i} cardIds={g.cards} label={`Group ${i + 1}`} wildcardRanks={revealWildcardRanks} />
                        ))}
                        {ungrouped.length > 0 && (
                          <GroupRow cardIds={sortHandForDisplay(ungrouped)} label="Ungrouped" wildcardRanks={revealWildcardRanks} />
                        )}
                      </div>
                    ) : (
                      <GroupRow cardIds={sortHandForDisplay(revealed.cards)} label="Final Hand" wildcardRanks={revealWildcardRanks} />
                    );
                  })()
                )}
              </div>
            );
          })}
        </main>
      </div>
    );
  }

  // ---- Active game ----
  const topDiscardEntry = game.discardPile[game.discardPile.length - 1] || null;
  const topDiscard = topDiscardEntry?.card || null;
  // Whether it's locked from pickup was decided server-side at the moment it was discarded, based
  // on whether THAT discarder had personally seen it as a joker yet (see /api/rummy/discard) — not
  // recomputed here, since the same rank could be locked or not depending on who let go of it.
  const topDiscardIsJoker = !!topDiscardEntry?.locked;
  // The "— joker" HINT shown below is a separate, viewer-relative question from the pickup lock
  // above: `locked` reflects whether the DISCARDER had seen it as a joker, so showing that label to
  // everyone would leak the second joker's rank to players who haven't personally unlocked it
  // themselves the moment anyone-who-had discarded one. `wildcardRanks` is already the correct
  // per-viewer set (rank1 always, rank2 only once `me?.hasSecondJoker`) — reuse it here too.
  const topDiscardRank = topDiscard ? parseCard(topDiscard).rank : null;
  const topDiscardIsJokerForMe = topDiscardRank !== null && wildcardRanks.includes(topDiscardRank);
  const canAct = isMyTurn && !me?.dropped && mode === 'none';
  const canDrawDiscard = canAct && game.turnPhase === 'draw' && !!topDiscard && !topDiscardIsJoker && !busy;
  const canDrawStock = canAct && game.turnPhase === 'draw';
  const canDiscardNow = canAct && game.turnPhase === 'discard';

  // ---- Drag & drop ----
  const avatarSrcFor = (uid: string, stored?: string) =>
    photoByUid[uid] || stored || (uid === user.uid ? profile?.photoURL || user.photoURL || '' : '');

  const moveCardToGroup = (c: string, groupIdx: number) => {
    setHandGroups((gs) => {
      if (gs[groupIdx]?.includes(c)) return gs;
      return gs
        .map((g, i) => (i === groupIdx ? [...g.filter((x) => x !== c), c] : g.filter((x) => x !== c)))
        .filter((g) => g.length > 0);
    });
    setSelectedForGroup((sel) => sel.filter((x) => x !== c));
  };
  const moveCardToLoose = (c: string) => {
    setHandGroups((gs) => gs.map((g) => g.filter((x) => x !== c)).filter((g) => g.length > 0));
    setSelectedForGroup((sel) => sel.filter((x) => x !== c));
  };
  // Where did a dragged card land? On the table (at least a quarter of the card over it, middle
  // within its width) it's discarded — only on your discard turn; otherwise whichever group or the
  // loose-cards area sits under the card's centre; anywhere else it just snaps back.
  const handleCardDrop = (c: string, rect: DOMRect) => {
    const tableRect = tableDropRef.current?.getBoundingClientRect();
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    if (canDiscardNow && !busy && tableRect) {
      const overlapY = Math.min(rect.bottom, tableRect.bottom) - Math.max(rect.top, tableRect.top);
      if (overlapY >= rect.height * 0.25 && cx >= tableRect.left && cx <= tableRect.right) {
        handleQuickDiscard(c);
        return;
      }
    }
    const under = document.elementsFromPoint(cx, cy).filter((e): e is HTMLElement => e instanceof HTMLElement);
    const groupEl = under.find((e) => e.dataset.groupIdx !== undefined);
    if (groupEl) { moveCardToGroup(c, Number(groupEl.dataset.groupIdx)); return; }
    if (under.some((e) => e.dataset.looseArea !== undefined)) moveCardToLoose(c);
  };

  // Three ways to leave: "just leave" keeps your seat (no penalty); the other two forfeit via Drop.
  const handleGoToLobby = () => { setShowExitMenu(false); navigate('/games/rummy'); };
  const handleQuitAndGoToLobby = async () => {
    setShowExitMenu(false);
    await handleDrop();
    navigate('/games/rummy');
  };

  const turnStatusText = me?.dropped
    ? 'You dropped'
    : isMyTurn
    ? game.turnPhase === 'draw'
      ? 'Your turn — draw'
      : 'Your turn — discard'
    : `${game.players[game.currentTurnSeatIndex]?.displayName || '…'}'s turn`;

  const dragEnabled = !me?.dropped && mode === 'none';

  const renderHandCard = (c: string, key: string, isLast: boolean) => {
    const { selected, onClick } = getCardInteraction(c);
    return (
      <div key={key} className={isLast ? 'shrink-0' : 'flex-1 min-w-0 max-w-[var(--cw)]'}>
        <DraggableCard enabled={dragEnabled} draggedFlag={cardWasDragged} onDragState={setIsDraggingCard} onDrop={(r) => handleCardDrop(c, r)}>
          <TableCard
            cardId={c}
            size="fan"
            selected={selected}
            highlight={c === lastDrawnCard}
            onClick={onClick ? () => { if (!cardWasDragged.current) onClick(); } : undefined}
            wildcardRanks={wildcardRanks}
          />
        </DraggableCard>
      </div>
    );
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <ReactionOverlay reactions={floatingReactions} />
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[260] max-w-[92vw] pointer-events-none">
        <AnimatePresence>
          {jokerToast && (
            <motion.div
              key={jokerToast.id}
              initial={{ y: -50, opacity: 0, scale: 0.85 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: -40, opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', damping: 16, stiffness: 260 }}
              className="bg-primary text-white text-xs font-bold pl-2.5 pr-4 py-2 rounded-full shadow-xl flex items-center gap-2"
            >
              <motion.span
                className="text-base shrink-0"
                animate={{ rotate: [0, -15, 15, -10, 10, 0] }}
                transition={{ duration: 0.6, delay: 0.15 }}
              >
                🃏
              </motion.span>
              <span>{jokerToast.text}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {showHelp && <GameHelpModal content={RUMMY_HELP} onClose={() => setShowHelp(false)} />}
      {showChat && user && (
        <ChatPanel
          collectionName="rummyGames"
          gameId={gameId!}
          messages={chatMessages}
          loading={chatLoading}
          myUid={user.uid}
          myDisplayName={profile?.displayName || user.displayName || 'Player'}
          myPhotoURL={profile?.photoURL || user.photoURL || ''}
          otherUids={game.players.filter((p) => p.uid !== user.uid).map((p) => p.uid)}
          onClose={() => setShowChat(false)}
        />
      )}

      {showExitMenu && (
        <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowExitMenu(false)}>
          <div className="w-full max-w-xs bg-white rounded-3xl shadow-2xl p-4 space-y-2" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-bold text-text-muted uppercase tracking-wider text-center pb-1">Leave this game?</p>
            <button onClick={handleGoToLobby} className="w-full py-3 bg-surface rounded-2xl text-sm font-bold text-on-surface text-left px-4">
              <span className="block">Go to Lobby</span>
              <span className="block text-[10px] font-medium text-text-muted mt-0.5">Keeps your seat — come back anytime</span>
            </button>
            <button onClick={handleQuitAndGoToLobby} className="w-full py-3 bg-surface rounded-2xl text-sm font-bold text-error text-left px-4">
              <span className="block">Quit &amp; Go to Lobby</span>
              <span className="block text-[10px] font-medium text-text-muted mt-0.5">Drops out of this game (you cannot rejoin)</span>
            </button>
            <button onClick={() => setShowExitMenu(false)} className="w-full py-2.5 text-sm font-bold text-text-muted">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Full-screen table (covers the app header and tab bar) — built for a phone held sideways:
          header strip on top, the felt table and your hand on the left, the action buttons in a
          column on the right. Held upright it simply stacks the same pieces. */}
      <div className="fixed inset-0 z-[150] flex flex-col bg-surface overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        {!portraitHintDismissed && (
          <div className="hidden portrait:flex absolute inset-0 z-[160] flex-col items-center justify-center gap-4 bg-primary/95 text-white text-center p-8">
            <motion.span
              className="material-symbols-outlined text-[72px] block"
              animate={{ rotate: [0, 0, -90, -90, 0] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut', times: [0, 0.2, 0.5, 0.8, 1] }}
            >
              screen_rotation
            </motion.span>
            <div className="space-y-1">
              <p className="text-lg font-black">Turn your phone sideways</p>
              <p className="text-sm text-white/80">27-Hand Rummy plays best in landscape — your whole hand fits in one row.</p>
            </div>
            <button
              onClick={() => setPortraitHintDismissed(true)}
              className="mt-2 px-4 py-2 rounded-xl border border-white/40 text-xs font-bold text-white/90"
            >
              Play in portrait anyway
            </button>
          </div>
        )}

        <header className="shrink-0 px-2 py-1 flex items-center gap-2 bg-white border-b border-border-subtle">
          <div className="flex flex-col leading-tight">
            <h1 className="font-black text-primary text-xs">27-Hand Rummy</h1>
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{game.code}</span>
          </div>
          <ReactionButton onSend={handleSendReaction} />
          <p className={`flex-1 min-w-0 truncate text-center text-[11px] font-bold ${isMyTurn ? 'text-primary' : 'text-text-muted'}`}>{turnStatusText}</p>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={handleDrop} disabled={busy || me?.dropped} className="p-1.5 text-error shrink-0 disabled:opacity-30" aria-label="Drop">
              <span className="material-symbols-outlined text-[20px] block">flag</span>
            </button>
            <button onClick={() => setShowExitMenu(true)} className="p-1.5 text-text-muted shrink-0" aria-label="Exit Game">
              <span className="material-symbols-outlined text-[20px] block">logout</span>
            </button>
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
        </header>

        <div className="flex-1 min-h-0 flex flex-col landscape:flex-row gap-2 p-2">
          <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2 [--cw:min(11vw,3.75rem)] landscape:[--cw:min(7vw,17vh,3.75rem)]">
            {/* Felt table: wooden rim, green baize with a soft spotlight. Seats along the top (avatar,
                name, cards left); the discard pile in the middle, the jokers bottom-left and the draw
                deck bottom-right. */}
            <div
              ref={tableDropRef}
              className={`relative flex-1 min-h-[9rem] flex flex-col rounded-[1.5rem] border-[5px] p-2 gap-1 overflow-hidden transition-all shadow-[inset_0_0_36px_rgba(0,0,0,0.5),0_6px_16px_rgba(0,0,0,0.25)] bg-[radial-gradient(ellipse_at_center,#1f7a5a_0%,#165c44_55%,#0e3f2f_100%)] ${
                isDraggingCard && canDiscardNow ? 'border-amber-300 ring-4 ring-amber-300/40' : 'border-[#4a3322]'
              }`}
            >
              <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-[9rem] leading-none text-white/[0.05] select-none">♥</span>
              <div className="relative shrink-0 flex items-stretch justify-center gap-1.5 flex-wrap">
                {game.players.map((p, i) => {
                  const isTurn = i === game.currentTurnSeatIndex && !p.dropped;
                  return (
                    <div
                      key={p.uid}
                      className={`flex items-center gap-1.5 w-[min(30vw,8.5rem)] rounded-xl px-1.5 py-1 backdrop-blur-sm transition-colors ${
                        isTurn ? 'bg-amber-300/15 ring-1 ring-amber-300/60' : 'bg-black/20'
                      } ${p.dropped ? 'opacity-45' : ''}`}
                    >
                      <div className={`relative w-8 h-8 shrink-0 rounded-full bg-emerald-950 flex items-center justify-center text-white text-xs font-bold ${isTurn ? 'ring-2 ring-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.85)]' : 'ring-1 ring-white/30'}`}>
                        <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center">
                          {p.isBot ? (
                            <span className="text-base leading-none">🤖</span>
                          ) : avatarSrcFor(p.uid, p.photoURL) ? (
                            <img src={avatarSrcFor(p.uid, p.photoURL)} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            p.displayName?.slice(0, 1) || '?'
                          )}
                        </div>
                        <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2 h-2" />
                      </div>
                      <div className="flex flex-col min-w-0 leading-tight">
                        <span className={`text-[10px] font-semibold truncate ${isTurn ? 'text-amber-200' : 'text-white'}`}>
                          {p.uid === user.uid ? 'You' : p.displayName || '…'}
                        </span>
                        <span className="text-[9px] whitespace-nowrap text-emerald-100/80 flex items-center gap-1">
                          {p.dropped ? 'out' : `${p.handCount} cards`}
                          {p.hasSecondJoker && <span className="material-symbols-outlined text-[11px] text-amber-300">auto_awesome</span>}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="relative flex-1 min-h-[6.5rem]">
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                  <span className="text-[9px] font-bold text-emerald-100/70 uppercase tracking-widest">
                    Discard{topDiscardIsJokerForMe && <span className="text-amber-300 normal-case"> — joker</span>}
                  </span>
                  {topDiscard ? (
                    <div className={`rounded-lg drop-shadow-[0_3px_5px_rgba(0,0,0,0.45)] ${canDrawDiscard ? 'ring-4 ring-amber-300/70 animate-pulse' : ''}`}>
                      <TableCard cardId={topDiscard} dim={isMyTurn && game.turnPhase === 'draw' && !canDrawDiscard} onClick={canDrawDiscard ? handleDrawDiscard : undefined} wildcardRanks={wildcardRanks} />
                    </div>
                  ) : (
                    <div className="w-[min(14vw,3.75rem)] landscape:w-[min(14vh,3.25rem)] aspect-[5/7] rounded-lg border-2 border-dashed border-white/25 bg-black/10" />
                  )}
                </div>

                {(game.jokerCard1 || game.jokerCard2) && (
                  <div className="absolute bottom-0 left-1 flex flex-col items-center gap-1">
                    <span className="text-[9px] font-bold text-emerald-100/70 uppercase tracking-widest">Jokers</span>
                    <div className="flex items-center gap-1.5 drop-shadow-[0_3px_5px_rgba(0,0,0,0.45)]">
                      {game.jokerCard1 && <TableCard cardId={game.jokerCard1} />}
                      {game.jokerCard2 && <TableCard cardId={game.jokerCard2} faceDown={!me?.hasSecondJoker} />}
                    </div>
                  </div>
                )}

                <div className="absolute bottom-0 right-2 flex flex-col items-center gap-1">
                  <span className="text-[9px] font-bold text-emerald-100/70 uppercase tracking-widest">Draw · {game.stockCount}</span>
                  {/* A small stacked deck: two card edges peek out behind the top card. */}
                  <div className={`relative ${canDrawStock ? 'animate-pulse' : 'opacity-70'}`}>
                    <div className="absolute inset-0 translate-x-1.5 translate-y-1.5 rounded-lg border-2 border-white/40 bg-[#0b2f45] shadow-md" />
                    <div className="absolute inset-0 translate-x-[3px] translate-y-[3px] rounded-lg border-2 border-white/50 bg-[#0f4761] shadow-md" />
                    <div className={`relative rounded-lg drop-shadow-[0_3px_5px_rgba(0,0,0,0.45)] ${canDrawStock ? 'ring-4 ring-amber-300/70' : ''}`}>
                      <TableCard cardId="AS" faceDown onClick={canDrawStock && !busy ? handleDrawStock : undefined} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* The whole hand in ONE row: each group is a run of overlapping cards with a bar (and its
                controls) underneath, followed by the loose cards, also overlapping. Every run shares the
                row's width — overlap is whatever it takes to fit — so nothing wraps or scrolls sideways.
                Drag a card onto another group to move it there, onto the loose cards / empty space to take
                it out of its group, or onto the table to discard it. */}
            <div
              data-loose-area=""
              className={`flex justify-center items-start gap-2 px-1 pt-1 min-h-[7.75rem] rounded-lg transition-colors ${isDraggingCard ? 'border border-dashed border-primary bg-primary/5' : 'border border-transparent'}`}
            >
              {visibleHandGroups.map(({ idx, cards }) => {
                const n = cards.length;
                const valid = isValidGroup(cards, wildcardRanks).valid;
                return (
                  <div
                    key={`group-${idx}`}
                    data-group-idx={idx}
                    style={{ flex: `${Math.max(n - 1, 0)} 1 calc(var(--cw) + 0.25rem)`, minWidth: 0, maxWidth: `calc(var(--cw) * ${n} + 0.25rem)` }}
                    className={`flex flex-col rounded-lg p-0.5 transition-colors ${isDraggingCard ? 'bg-primary/10 ring-1 ring-primary/40' : ''}`}
                  >
                    <div className="flex">{cards.map((c, i) => renderHandCard(c, `${c}-${i}`, i === n - 1))}</div>
                    <div className={`mt-1 h-1 rounded-full ${valid ? 'bg-success' : 'bg-text-muted/40'}`} />
                    <div className="flex items-center justify-center gap-1 mt-0.5">
                      {mode === 'none' && (
                        <button
                          onClick={() => setHandGroups((gs) => gs.filter((_, gi) => gi !== idx))}
                          aria-label="Ungroup"
                          className="w-5 h-5 rounded-full bg-white border border-border-subtle shadow-sm flex items-center justify-center text-text-muted"
                        >
                          <span className="material-symbols-outlined text-[13px] leading-none">close</span>
                        </button>
                      )}
                      {mode === 'none' && !me?.dropped && selectedForGroup.length > 0 && (
                        <button
                          onClick={() => handleAddSelectedToGroup(idx)}
                          aria-label="Add selected cards here"
                          className="flex items-center gap-0.5 h-5 min-w-[20px] px-1 rounded-full bg-primary text-white text-[10px] font-black shadow-sm"
                        >
                          <span className="material-symbols-outlined text-[12px] leading-none">add</span>
                          {selectedForGroup.length}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {handGridCards.length > 0 && (
                <div
                  style={{ flex: `${Math.max(handGridCards.length - 1, 0)} 1 var(--cw)`, minWidth: 0, maxWidth: `calc(var(--cw) * ${handGridCards.length})` }}
                  className="flex flex-col"
                >
                  <div className="flex">{handGridCards.map((c, idx) => renderHandCard(c, `${c}-${idx}`, idx === handGridCards.length - 1))}</div>
                  <div className="mt-1 h-1 rounded-full bg-text-muted/20" />
                </div>
              )}
            </div>
          </div>

          <aside className="landscape:w-40 landscape:shrink-0 flex flex-row landscape:flex-col flex-wrap items-center landscape:items-stretch gap-1.5 landscape:overflow-y-auto">
            {error && <p className="text-xs font-bold text-error w-full">{error}</p>}

            {me?.dropped && (
              <div className="w-full rounded-xl border border-border-subtle bg-white p-2">
                <p className="text-[11px] font-bold text-text-muted">You dropped out of this game. You can keep watching.</p>
              </div>
            )}

            {/* Meld 5-4-3 mode — reveals the 2nd joker only; these cards stay in your hand */}
            {mode === 'meld543' && (
              <div className="w-full space-y-1.5">
                <p className="text-[10px] text-text-muted leading-snug">
                  Tap cards to fill the 5-run, then the 4-run, then the 3-run — all pure sequences (no jokers). They stay in your hand; this only unlocks your 2nd joker.
                </p>
                <GroupRow cardIds={meldSlots.five} valid={meldSlots.five.length === 5 && isPureSequence(meldSlots.five)} label="5-run" wildcardRanks={wildcardRanks} />
                <GroupRow cardIds={meldSlots.four} valid={meldSlots.four.length === 4 && isPureSequence(meldSlots.four)} label="4-run" wildcardRanks={wildcardRanks} />
                <GroupRow cardIds={meldSlots.three} valid={meldSlots.three.length === 3 && isPureSequence(meldSlots.three)} label="3-run" wildcardRanks={wildcardRanks} />
                <button
                  onClick={handleMeldSubmit}
                  disabled={!meldValid || busy}
                  className="w-full py-2 bg-primary text-white font-bold rounded-lg text-xs disabled:opacity-50"
                >
                  Submit Declaration
                </button>
                <button onClick={resetSelections} className="w-full py-1.5 bg-white border border-border-subtle rounded-lg text-xs font-bold">
                  Cancel
                </button>
              </div>
            )}

            {mode === 'none' && !me?.dropped && (
              <>
                <button
                  onClick={handleGroupSelected}
                  disabled={selectedForGroup.length < 2}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-bold disabled:opacity-30 disabled:bg-text-muted"
                >
                  <span className="material-symbols-outlined text-[15px]">call_merge</span>
                  Make Group{selectedForGroup.length > 0 ? ` (${selectedForGroup.length})` : ''}
                </button>
                {selectedForGroup.length > 0 && (
                  <button onClick={() => setSelectedForGroup([])} className="text-[11px] font-bold text-text-muted py-1">
                    Clear Selection
                  </button>
                )}
                {selectedForGroup.length === 1 && canDiscardNow && (
                  <button
                    onClick={() => handleQuickDiscard(selectedForGroup[0])}
                    disabled={busy}
                    className="text-[11px] font-bold text-white bg-error px-2.5 py-1.5 rounded-lg disabled:opacity-50"
                  >
                    Discard This Card
                  </button>
                )}
                {canUngroupSelected && (
                  <button onClick={handleUngroupSelected} className="text-[11px] font-bold text-error py-1">
                    Ungroup Selected
                  </button>
                )}
              </>
            )}

            {isMyTurn && !me?.dropped && game.turnPhase === 'discard' && mode === 'none' && (
              <div className="flex flex-col gap-1 landscape:w-full">
                {!me?.pureRun543At && (
                  <button onClick={handleEnterMeld543} className="px-3 py-1.5 bg-white border border-border-subtle rounded-lg text-xs font-bold">
                    Declare 5-4-3 (2nd Joker)
                  </button>
                )}
                <button
                  onClick={handleDeclareWinNow}
                  disabled={!canDeclareWinNow || busy}
                  className="px-3 py-1.5 bg-success text-white rounded-lg text-xs font-bold disabled:opacity-30 disabled:bg-success/40"
                >
                  Declare Win
                </button>
                {!canDeclareWinNow && (
                  <span className="text-[10px] text-text-muted">
                    {looseForWin.length !== 1
                      ? `${looseForWin.length} card(s) ungrouped`
                      : 'need a 5, 4 & 3 pure sequence among your groups'}
                  </span>
                )}
              </div>
            )}

            <p className="text-[10px] text-text-muted italic landscape:mt-auto">
              Your hand ({handSorted.length}) ·{' '}
              {mode === 'meld543'
                ? 'tap the cards for each run'
                : canDiscardNow
                ? 'drag a card onto the table to discard it, or into a group to organize'
                : 'drag cards between groups, or tap to select and group them'}
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}
