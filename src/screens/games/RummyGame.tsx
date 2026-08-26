import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { doc, updateDoc, collection, query, where } from 'firebase/firestore';
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
import InvitePicker from '../../components/InvitePicker';
import PresenceDot from '../../components/PresenceDot';
import ShareGameButton from '../../components/ShareGameButton';
import Fireworks from '../../components/Fireworks';
import { useGameTurnPresence } from '../../lib/gameTurnPresence';

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
          <button onClick={() => navigate('/games/rummy')} className="text-text-muted">
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          </button>
          <h1 className="font-black text-primary">27-Hand Rummy</h1>
          <ReactionButton onSend={handleSendReaction} />
          <div className="flex items-center gap-1 ml-auto">
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
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
                <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold">
                  {p.displayName?.slice(0, 1) || '?'}
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
            <button onClick={() => navigate('/games/rummy')} className="flex-1 py-2.5 bg-primary text-white font-bold rounded-2xl text-sm">
              Back to Lobby
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

  const turnStatusText = me?.dropped
    ? 'You dropped'
    : isMyTurn
    ? game.turnPhase === 'draw'
      ? 'Your turn — draw'
      : 'Your turn — discard'
    : `${game.players[game.currentTurnSeatIndex]?.displayName || '…'}'s turn`;

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
      {/* GameHelpModal/ChatPanel render OUTSIDE the fixed wrapper below, as top-level siblings —
          not because a `fixed` descendant's own positioning would be confined by nesting (it
          wouldn't; that part of the old reasoning here was right), but because its STACKING order
          would be: a `position:fixed` ancestor with its own z-index (the wrapper below is `z-30`)
          creates a new stacking context, and z-index only ever competes among siblings *within*
          the same stacking context — so a nested modal's own `z-[280]` would only win against
          siblings inside that z-30 context, not against the real page-level bottom Navigation bar
          (`z-50`), which sits in the page's root stacking context alongside this wrapper itself.
          Nested, the modal was rendering visually on top but the *page-level* z-30 vs z-50
          comparison still let Navigation intercept taps on whatever overlapped it — exactly what
          made the chat input unusable near the bottom of the screen. Rendering these as true
          top-level siblings (like ReactionOverlay/the joker toast above) puts their z-[280] back
          in the same stacking context as Navigation's z-50, where 280 actually wins. */}
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
      {/* The ENTIRE screen is pinned between the global app Header (App.tsx's `<Header />`,
          `min-h-[60px]` plus env(safe-area-inset-top) on iOS — Header.tsx pads for the
          notch/status bar, so its real height varies by device, not a flat 60px) and the fixed
          bottom Navigation bar (`h-16` = 64px, plus env(safe-area-inset-bottom) on iOS —
          Navigation.tsx pads for the home indicator, same reasoning as Header.tsx above) —
          `position: fixed` with both `top` and `bottom`
          set gives this a fully DEFINITE height regardless of whatever AuthenticatedLayout's own
          `<main>` scrolling setup does, and takes it completely out of normal document flow, so
          it can never itself contribute to a page/window-level scroll no matter how much it
          contains. Inside that fixed box: everything down through "Your Hand" is `shrink-0` (its
          natural height, never scrolls); only the hand section below it is `flex-1 min-h-0
          overflow-y-auto`, so it's the ONLY thing that scrolls, and only when there are actually
          more groups/cards than the remaining space can show. `overflow-hidden` on the outer box
          is a safety net for an extremely short viewport where even the fixed top content alone
          would exceed the available height — clips rather than pushing content down under the
          nav bar. */}
      <div className="fixed inset-x-0 top-[calc(60px+env(safe-area-inset-top))] bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 flex flex-col bg-surface overflow-hidden">
        <div className="shrink-0">
        <header className="p-2 flex items-center gap-2 bg-white border-b border-border-subtle">
          <button onClick={() => navigate('/games/rummy')} className="text-text-muted">
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          </button>
          <div className="flex flex-col leading-tight">
            <h1 className="font-black text-primary text-xs">27-Hand Rummy</h1>
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{game.code}</span>
          </div>
          <ReactionButton onSend={handleSendReaction} />
          <div className="flex items-center gap-1.5 ml-auto">
            <button onClick={handleDrop} disabled={busy || me?.dropped} className="p-2 text-error shrink-0 disabled:opacity-30" aria-label="Leave game">
              <span className="material-symbols-outlined text-[22px] block">logout</span>
            </button>
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
        </header>

        <div className="p-2 max-w-xl mx-auto w-full space-y-2">
          {/* Turn status + players + jokers/draw/discard + Make Group, combined into one compact
              status card that never scrolls out of view. */}
          <div className="bg-white rounded-xl border border-border-subtle p-2 space-y-1.5">
            <p className={`text-[11px] font-bold ${isMyTurn ? 'text-primary' : 'text-text-muted'}`}>{turnStatusText}</p>

            <div className="flex items-center gap-1.5 overflow-x-auto">
              {game.players.map((p, i) => (
                <div
                  key={p.uid}
                  className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border shrink-0 ${
                    i === game.currentTurnSeatIndex ? 'border-primary bg-primary/5' : 'border-border-subtle'
                  } ${p.dropped ? 'opacity-40' : ''}`}
                >
                  <div className="relative w-5 h-5 shrink-0">
                    <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center text-white text-[9px] font-bold">
                      {p.displayName?.slice(0, 1) || '?'}
                    </div>
                    <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2 h-2" />
                  </div>
                  <span className="text-[10px] font-bold text-on-surface whitespace-nowrap">{p.uid === user.uid ? 'You' : p.displayName}</span>
                  <span className="text-[9px] text-text-muted whitespace-nowrap">{p.dropped ? 'out' : p.handCount}</span>
                  {p.hasSecondJoker && <span className="material-symbols-outlined text-[11px] text-warning">auto_awesome</span>}
                </div>
              ))}
            </div>

            {/* Jokers, then the discard pile (same size as the jokers) past a vertical divider,
                then the draw-from-stock button pinned to the far right — the discard pile is
                always visible to everyone, tappable only by the player whose turn it is, during
                their draw phase. */}
            <div className="flex items-center gap-2 pt-1.5 border-t border-border-subtle overflow-x-auto">
              <div className="flex items-center gap-1.5 shrink-0">
                {game.jokerCard1 && <CardChip cardId={game.jokerCard1} />}
                {game.jokerCard2 && <CardChip cardId={game.jokerCard2} faceDown={!me?.hasSecondJoker} />}
              </div>
              <div className="w-px self-stretch bg-border-subtle shrink-0" />
              {/* Blinks light blue whenever it's your move — replaces the old whole-screen glow
                  with a turn cue localized to the one spot you actually act on (draw phase: tap
                  this to take the discard; discard phase: this is where your card will land). */}
              <div
                className={`flex items-center gap-1.5 shrink-0 rounded-lg px-1.5 py-1 -my-1 transition-colors ${
                  isMyTurn && !me?.dropped ? 'bg-sky-200 animate-pulse' : ''
                }`}
              >
                <p className="text-[9px] font-bold text-text-muted uppercase leading-tight whitespace-nowrap">
                  Discard{topDiscardIsJokerForMe && <span className="text-warning normal-case"> — joker</span>}
                </p>
                {topDiscard ? (
                  <CardChip cardId={topDiscard} dim={!canDrawDiscard} onClick={canDrawDiscard ? handleDrawDiscard : undefined} wildcardRanks={wildcardRanks} />
                ) : (
                  <p className="text-[10px] text-text-muted italic whitespace-nowrap">Empty</p>
                )}
              </div>
              <button
                onClick={canDrawStock ? handleDrawStock : undefined}
                disabled={busy || !canDrawStock}
                className={`ml-auto px-2.5 py-1.5 rounded-lg text-[11px] font-bold shrink-0 disabled:opacity-40 ${
                  canDrawStock ? 'bg-primary text-white' : 'bg-surface text-text-muted border border-border-subtle'
                }`}
              >
                Draw {game.stockCount}
              </button>
            </div>

            {/* Make Group — a real, persistently-visible button pinned right below the
                joker/discard row (not a text link that only appears once 2+ cards are selected),
                so it's always reachable without scrolling down into the hand. Tap cards below
                (loose or already grouped) to select them, then tap this. */}
            {mode === 'none' && !me?.dropped && (
              <div className="flex items-center gap-2 pt-1.5 border-t border-border-subtle">
                <button
                  onClick={handleGroupSelected}
                  disabled={selectedForGroup.length < 2}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-bold disabled:opacity-30 disabled:bg-text-muted"
                >
                  <span className="material-symbols-outlined text-[15px]">call_merge</span>
                  Make Group{selectedForGroup.length > 0 ? ` (${selectedForGroup.length})` : ''}
                </button>
                {selectedForGroup.length > 0 && (
                  <button onClick={() => setSelectedForGroup([])} className="text-[11px] font-bold text-text-muted">
                    Clear Selection
                  </button>
                )}
              </div>
            )}
          </div>

          {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

          {/* Mode toolbar — discarding itself no longer needs a mode: tap a card below, then tap
              "Discard This Card" in the selection actions row (2 taps total). Declare Win works
              the same way: organize your whole hand with "Make Group" until exactly one card is
              left ungrouped and a 5/4/3 pure-sequence triple exists among the groups — the button
              lights up the moment that's true, exactly like Declare 5-4-3's own single-action
              pattern. */}
          {isMyTurn && !me?.dropped && game.turnPhase === 'discard' && mode === 'none' && (
            <div className="flex flex-wrap items-center gap-1.5">
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

          {/* Meld 5-4-3 mode — reveals the 2nd joker only; these cards stay in your hand */}
          {mode === 'meld543' && (
            <div className="space-y-2">
              <p className="text-xs text-text-muted px-1">
                Tap cards to fill the 5-run, then the 4-run, then the 3-run — all pure sequences (no jokers). These
                cards stay in your hand; this only unlocks your 2nd joker.
              </p>
              <GroupRow cardIds={meldSlots.five} valid={meldSlots.five.length === 5 && isPureSequence(meldSlots.five)} label="5-run" wildcardRanks={wildcardRanks} />
              <GroupRow cardIds={meldSlots.four} valid={meldSlots.four.length === 4 && isPureSequence(meldSlots.four)} label="4-run" wildcardRanks={wildcardRanks} />
              <GroupRow cardIds={meldSlots.three} valid={meldSlots.three.length === 3 && isPureSequence(meldSlots.three)} label="3-run" wildcardRanks={wildcardRanks} />
              <div className="flex gap-2">
                <button
                  onClick={handleMeldSubmit}
                  disabled={!meldValid || busy}
                  className="flex-1 py-2 bg-primary text-white font-bold rounded-lg text-sm disabled:opacity-50"
                >
                  Submit Declaration
                </button>
                <button onClick={resetSelections} className="px-4 py-2 bg-white border border-border-subtle rounded-lg text-sm font-bold">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Hand header — count + contextual selection actions, stays fixed alongside everything
              above; only the groups/cards themselves (below) scroll. */}
          <div className="flex items-center justify-between px-1 gap-2 flex-wrap">
            <p className="text-[10px] font-bold text-text-muted uppercase">Your Hand ({handSorted.length})</p>
            {mode === 'none' &&
              !me?.dropped &&
              (selectedForGroup.length > 0 ? (
                <div className="flex items-center gap-3 flex-wrap">
                  {selectedForGroup.length === 1 && canDiscardNow && (
                    <button
                      onClick={() => handleQuickDiscard(selectedForGroup[0])}
                      disabled={busy}
                      className="text-[11px] font-bold text-white bg-error px-2.5 py-1 rounded-lg disabled:opacity-50"
                    >
                      Discard This Card
                    </button>
                  )}
                  {canUngroupSelected && (
                    <button onClick={handleUngroupSelected} className="text-[11px] font-bold text-error">
                      Ungroup Selected
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-[10px] text-text-muted italic">
                  {canDiscardNow ? 'Tap a card to discard it, or select several to organize' : 'Tap cards to select, then tap + on a group to add them there'}
                </p>
              ))}
          </div>
        </div>
        </div>

        {/* Hand — the ONLY part of this screen that scrolls, and only within whatever space is
            left after everything above it. With no action in progress, tapping ANY card (loose or
            already grouped) just selects it; "Make Group" / "Ungroup Selected" then act on the
            whole selection at once, so you can freely organize into as many groups as you like
            before declaring anything, without a separate mode to enter/exit. Groups run 2-per-row
            since a single full-width group wasted a lot of space, and each group still scrolls
            horizontally within its own lane if it holds more cards than fit. */}
        <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-2 max-w-xl mx-auto w-full pb-6 space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            {visibleHandGroups.map(({ idx, cards }) => (
              <GroupRow
                key={idx}
                cardIds={cards}
                valid={isValidGroup(cards, wildcardRanks).valid}
                onRemove={mode === 'none' ? () => setHandGroups((gs) => gs.filter((_, i) => i !== idx)) : undefined}
                onCardClick={(id) => getCardInteraction(id).onClick?.()}
                selectedIds={cards.filter((id) => getCardInteraction(id).selected)}
                highlightId={lastDrawnCard}
                onAddSelected={mode === 'none' && !me?.dropped && selectedForGroup.length > 0 ? () => handleAddSelectedToGroup(idx) : undefined}
                addSelectedCount={selectedForGroup.length}
                wildcardRanks={wildcardRanks}
              />
            ))}
          </div>

          <div className="flex gap-1.5 flex-wrap">
            {handGridCards.map((c, idx) => {
              const { selected, onClick } = getCardInteraction(c);
              // Keyed by value+position — 3 combined decks routinely deal duplicate cards into
              // the same hand, and a bare `key={c}` collision between identical cards causes
              // React to misattribute clicks/DOM nodes between them after the hand resorts.
              return <CardChip key={`${c}-${idx}`} cardId={c} selected={selected} highlight={c === lastDrawnCard} onClick={onClick} wildcardRanks={wildcardRanks} />;
            })}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
