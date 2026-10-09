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
  isPrintedJoker,
  withPrintedJoker,
  SUIT_SYMBOL,
  SUIT_RED,
  isPureSequence,
  isValidSequence,
  isValidGroup,
  sortHandForDisplay,
  computeRummy13HandPenalty,
  cardValue,
  bestShowArrangement,
  TURN_TIMEOUT_MS,
  TURN_WARNING_MS,
  type Rummy13Table,
  type Rummy13Deal,
  type Rummy13DealSummary,
  type Rank,
} from '../../lib/rummy13';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { RUMMY13_HELP } from '../../lib/gameHelp';
import { ReactionButton, ReactionOverlay, useReactionOverlay } from '../../components/GameReactions';
import { ChatButton, ChatPanel, useGameChat } from '../../components/GameChat';
import { VoiceChatButton, useGameVoice } from '../../components/GameVoiceChat';
import InvitePicker from '../../components/InvitePicker';
import PresenceDot from '../../components/PresenceDot';
import ShareGameButton from '../../components/ShareGameButton';
import Fireworks from '../../components/Fireworks';
import DraggableCard from '../../components/DraggableCard';
import { useGameTurnPresence } from '../../lib/gameTurnPresence';
import { lockLandscape, unlockOrientation } from '../../lib/screenOrientation';

type SelectionMode = 'none';

const handGroupsStorageKey = (dealId: string, uid: string) => `familyledger_rummy13_handgroups_${dealId}_${uid}`;

function loadStoredHandGroups(dealId: string, uid: string, currentHand: string[]): string[][] {
  try {
    const raw = localStorage.getItem(handGroupsStorageKey(dealId, uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const handSet = new Set(currentHand);
    return parsed
      .map((g: unknown) => (Array.isArray(g) ? g.filter((c): c is string => typeof c === 'string' && handSet.has(c)) : []))
      .filter((g: string[]) => g.length > 0);
  } catch {
    return [];
  }
}

// "Swallow the value already present on mount, only fire on a genuinely NEW change" — same
// pattern as RummyGame.tsx's useJokerSpotted. Keyed by dealNumber: every deal-end (whether the
// table continues to a fresh deal or finishes outright) bumps it exactly once.
function useDealEndedToast(summary: Rummy13DealSummary | null | undefined, tableStatus: string | undefined) {
  const [toast, setToast] = useState<Rummy13DealSummary | null>(null);
  const seenRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (seenRef.current === undefined) {
      seenRef.current = summary?.dealNumber;
      return;
    }
    if (!summary || summary.dealNumber === seenRef.current) return;
    seenRef.current = summary.dealNumber;
    if (tableStatus !== 'active') return; // table finished — the Finished screen covers this instead
    setToast(summary);
    const id = summary.dealNumber;
    setTimeout(() => setToast((cur) => (cur?.dealNumber === id ? null : cur)), 4500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.dealNumber, tableStatus]);

  return toast;
}

const CardChip: React.FC<{
  cardId: string;
  selected?: boolean;
  dim?: boolean;
  highlight?: boolean;
  faceDown?: boolean;
  onClick?: () => void;
  size?: 'table' | 'fan';
  wildcardRanks?: string[];
}> = ({ cardId, selected, dim, highlight, faceDown, onClick, size = 'table', wildcardRanks }) => {
  const joker = isPrintedJoker(cardId);
  const { rank, suit } = parseCard(cardId);
  const red = !joker && SUIT_RED[suit];
  // `table` = cards lying on the table (discard / wild); `fan` and `group` overlap in a row, so rank +
  // suit sit in the top-left corner — the strip that stays visible under the next card.
  const corner = size === 'fan';
  const dims = size === 'fan'
    ? 'w-[min(15vw,3.75rem)] landscape:w-[min(9vw,17vh,3.75rem)] aspect-[5/7] text-sm pl-1 pt-0.5'
    : 'w-[min(14vw,3.75rem)] landscape:w-[min(14vh,3.25rem)] aspect-[5/7] text-sm';
  const suitSize = 'text-xl';
  const isWild = !faceDown && !joker && !!wildcardRanks?.includes(rank as Rank);
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      className={`relative ${dims} shrink-0 rounded-lg border-2 flex flex-col ${corner && !faceDown ? 'items-start justify-start' : 'items-center justify-center'} font-bold bg-white transition-all ${
        onClick ? 'cursor-pointer active:scale-95' : ''
      } ${
        highlight
          ? 'border-warning ring-2 ring-warning/60 shadow-md'
          : selected
          ? 'border-primary ring-2 ring-primary/70 shadow-md'
          : 'border-border-subtle'
      } ${dim ? 'opacity-40' : ''} ${faceDown ? 'bg-primary text-white border-white ring-1 ring-inset ring-white/50 [background-image:repeating-linear-gradient(45deg,rgba(255,255,255,0.14)_0_5px,transparent_5px_10px)]' : joker ? 'text-warning' : red ? 'text-error' : 'text-on-surface'}`}
    >
      {isWild && !corner && (
        <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-warning text-white flex items-center justify-center shadow">
          <span className="material-symbols-outlined text-[9px] leading-none">auto_awesome</span>
        </span>
      )}
      {faceDown ? (
        <span className="material-symbols-outlined rotate-180 text-[26px]">style</span>
      ) : joker ? (
        <span className={`${corner ? 'text-lg' : 'text-2xl'} leading-none`}>🃏</span>
      ) : (
        <>
          <span className="leading-none">{rank}</span>
          <span className={`${suitSize} leading-none`}>{SUIT_SYMBOL[suit]}</span>
          {/* In an overlapped row the top-right corner is hidden under the next card, so the wild
              marker sits in the visible left strip, just under the suit. */}
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

// Read-only run of cards for the end-of-deal reveal: overlapped in one row, sized to the row's width.
const GroupRow: React.FC<{ cardIds: string[]; valid?: boolean; label?: string; wildcardRanks?: string[] }> = ({ cardIds, valid, label, wildcardRanks }) => (
  <div style={{ ['--cw' as string]: 'min(15vw,3.75rem)' }} className={`p-1.5 rounded-lg border ${valid ? 'border-success bg-success/5' : 'border-border-subtle bg-surface'}`}>
    {label && <span className="text-[10px] font-bold text-text-muted uppercase block mb-1">{label}</span>}
    <div className="flex pt-1">
      {cardIds.map((c, idx) => (
        <div key={`${c}-${idx}`} className={idx === cardIds.length - 1 ? 'shrink-0' : 'flex-1 min-w-0 max-w-[var(--cw)]'}>
          <CardChip cardId={c} size="fan" wildcardRanks={wildcardRanks} />
        </div>
      ))}
    </div>
  </div>
);

const FORMAT_LABEL: Record<string, string> = { single: 'Single Deal', pool101: 'Pool 101', pool201: 'Pool 201' };

export default function Rummy13Game() {
  const { tableId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { friendCandidates } = useFriendships(user?.uid);

  const [tableSnap, tableLoading] = useDocument(tableId ? doc(db, 'rummy13Tables', tableId) : null);
  const table = tableSnap?.exists() ? (tableSnap.data() as Rummy13Table) : null;
  const dealId = table?.currentDealId || null;

  const [dealSnap, dealLoading] = useDocument(dealId ? doc(db, 'rummy13Deals', dealId) : null);
  const deal = dealSnap?.exists() ? (dealSnap.data() as Rummy13Deal) : null;

  const voice = useGameVoice('rummy13Tables', tableId, table?.players || []);

  // Current profile photos for everyone seated. The photo saved on the table when someone sat down
  // can be empty (or out of date), so the live profile is looked up too — otherwise a seat falls
  // back to a plain initial even though that player has a profile picture.
  const humanUids = useMemo(() => (table?.players || []).filter((p) => !p.isBot).map((p) => p.uid), [table?.players]);
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

  const shownPointsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!tableId || !user || table?.status !== 'finished') return;
    if (shownPointsRef.current.has(tableId)) return;
    shownPointsRef.current.add(tableId);
    showGamePointsIfAny('rummy13', tableId);
  }, [tableId, user, table?.status]);

  useGameTurnPresence('rummy13', tableId);

  // Played sideways by default: lock to landscape while a deal is in progress, release on the way out.
  const tableIsActive = table?.status === 'active';
  useEffect(() => {
    if (!tableIsActive) return;
    lockLandscape();
    return () => { unlockOrientation(); };
  }, [tableIsActive]);

  const floatingReactions = useReactionOverlay(table?.lastReaction);
  const dealEndedToast = useDealEndedToast(table?.lastDealSummary, table?.status);
  const handleSendReaction = async (emoji: string) => {
    if (!user || !tableId) return;
    try {
      const idToken = await user.getIdToken();
      await fetch('/api/games/react', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameType: 'rummy13', gameId: tableId, emoji }),
      });
    } catch (err) {
      console.error('Failed to send reaction:', err);
    }
  };

  const [handSnap] = useDocument(
    dealId && user && deal?.status === 'active' ? doc(db, 'rummy13Deals', dealId, 'hands', user.uid) : null,
  );
  const handCards: string[] = handSnap?.exists() ? (handSnap.data().cards || []) : [];
  const handSorted = useMemo(() => sortHandForDisplay(handCards), [handCards]);

  const [groupsMembersValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = groupsMembersValue?.docs.map((d) => d.data().groupId) || [];
  const [showInvite, setShowInvite] = useState(false);

  const { messages: chatMessages, loading: chatLoading, hasUnseen: chatUnseen, markSeen: markChatSeen } = useGameChat('rummy13Tables', tableId);
  const [searchParams, setSearchParams] = useSearchParams();
  const [showChat, setShowChat] = useState(false);
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
  const [showExitMenu, setShowExitMenu] = useState(false);
  const [mode] = useState<SelectionMode>('none');
  const [handGroups, setHandGroups] = useState<string[][]>([]);
  const [selectedForGroup, setSelectedForGroup] = useState<string[]>([]);
  const [lastDrawnCard, setLastDrawnCard] = useState<string | null>(null);
  // Drag-to-discard: the felt table is the drop target; isDraggingCard lights it up while a card is held.
  const tableDropRef = useRef<HTMLDivElement>(null);
  const [isDraggingCard, setIsDraggingCard] = useState(false);
  // True from the moment a card starts moving until just after release, so the click the browser
  // fires at the end of a drag is never mistaken for a tap-to-select.
  const cardWasDragged = useRef(false);
  // "Turn your phone" prompt shown while held upright; the player can wave it away for this session.
  const [portraitHintDismissed, setPortraitHintDismissed] = useState(false);

  const hydratedGroupsRef = useRef(false);
  useEffect(() => {
    hydratedGroupsRef.current = false;
    setHandGroups([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);
  useEffect(() => {
    if (hydratedGroupsRef.current || !dealId || !user || handCards.length === 0) return;
    hydratedGroupsRef.current = true;
    const stored = loadStoredHandGroups(dealId, user.uid, handCards);
    if (stored.length > 0) setHandGroups(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, user, handCards.length]);

  useEffect(() => {
    if (!hydratedGroupsRef.current || !dealId || !user) return;
    try {
      localStorage.setItem(handGroupsStorageKey(dealId, user.uid), JSON.stringify(handGroups));
    } catch {
      // localStorage unavailable — organization just won't persist.
    }
  }, [handGroups, dealId, user]);

  const groupsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hydratedGroupsRef.current || !dealId || !user || deal?.status !== 'active') return;
    if (groupsSyncTimerRef.current) clearTimeout(groupsSyncTimerRef.current);
    groupsSyncTimerRef.current = setTimeout(() => {
      updateDoc(doc(db, 'rummy13Deals', dealId, 'hands', user.uid), { groups: handGroups.map((g) => ({ cards: g })) }).catch(() => {});
    }, 800);
    return () => { if (groupsSyncTimerRef.current) clearTimeout(groupsSyncTimerRef.current); };
  }, [handGroups, dealId, user, deal?.status]);

  useEffect(() => {
    setLastDrawnCard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal?.currentTurnSeatIndex, dealId]);

  // Deal-scoped actions (draw/discard/declare/drop/timeout) key off `dealId`; table-scoped ones
  // (invite/delete/rematch, all defined right on the lobby/table doc) key off `tableId` — both
  // funnel through this one helper, which sends whichever id field the endpoint expects alongside
  // `gameId` always carrying the TABLE id too (every endpoint that also needs to notify/label off
  // the table — e.g. discard's notifyGameTurn — reads `deal.tableId` server-side instead).
  const call = async (path: string, body: Record<string, unknown>) => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: tableId, dealId, ...body }),
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

  // Best-effort, not tied to the `busy` lock above (any seated player's client fires this, not
  // just whoever's actually mid-action) — a failed/early call is expected and silently ignored;
  // see server.ts's /api/rummy13/timeout for why this is safe to race.
  const callTimeoutBestEffort = async (targetDealId: string) => {
    if (!user) return;
    try {
      const idToken = await user.getIdToken();
      await fetch('/api/rummy13/timeout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealId: targetDealId }),
      });
    } catch {
      // Ignore — another client's call likely already resolved it, or it hadn't actually timed out.
    }
  };

  // Turn-timer tick — recomputed every second from the deal's own authoritative `turnStartedAt`.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const turnStartedAtMs = deal?.turnStartedAt ? new Date(deal.turnStartedAt).getTime() : null;
  const remainingMs = deal?.status === 'active' && turnStartedAtMs !== null ? Math.max(0, TURN_TIMEOUT_MS - (nowTick - turnStartedAtMs)) : null;
  const remainingSec = remainingMs !== null ? Math.ceil(remainingMs / 1000) : null;
  const timeoutFiredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!dealId || !deal || deal.status !== 'active' || remainingMs === null) return;
    if (remainingMs > 0) return;
    const key = `${dealId}:${deal.turnStartedAt}`;
    if (timeoutFiredForRef.current === key) return;
    timeoutFiredForRef.current = key;
    callTimeoutBestEffort(dealId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingMs, dealId, deal?.turnStartedAt, deal?.status]);

  if (tableLoading || (table?.status === 'active' && dealLoading)) return <div className="p-8 text-center text-text-muted">Loading…</div>;
  if (!table || !user || !tableId) return <div className="p-8 text-center text-text-muted">Table not found.</div>;

  const myIndex = table.players.findIndex((p) => p.uid === user.uid);
  const me = myIndex >= 0 ? table.players[myIndex] : null;
  const isPlayer = !!me;
  const isPool = table.format !== 'single';
  const avatarSrcFor = (uid: string, stored?: string) =>
    photoByUid[uid] || stored || (uid === user.uid ? profile?.photoURL || user.photoURL || '' : '');

  const myDealIndex = deal?.players.findIndex((p) => p.uid === user.uid) ?? -1;
  const meInDeal = deal && myDealIndex >= 0 ? deal.players[myDealIndex] : null;
  const isMyTurn = deal?.status === 'active' && deal.players[deal.currentTurnSeatIndex]?.uid === user.uid;
  const wildcardRanks = withPrintedJoker(deal?.wildJokerRank ? [deal.wildJokerRank as Rank] : []);
  const handleJoinTable = async () => {
    if (!user || isPlayer || table.players.length >= table.maxPlayers) return;
    setError(null);
    try {
      const newPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: table.players.length,
        cumulativeScore: 0,
        eliminated: false,
      };
      await updateDoc(doc(db, 'rummy13Tables', tableId), {
        players: [...table.players, newPlayer],
        playerUids: [...table.playerUids, user.uid],
      });
    } catch (err) {
      console.error('Failed to join 13-Card Rummy table:', err);
      setError('Failed to join — the table may already be full or started.');
    }
  };

  const handleInvite = async (inviteeUids: string[], poke = false) => {
    if (!user || inviteeUids.length === 0) return;
    const idToken = await user.getIdToken();
    await fetch('/api/rummy13/invite', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: tableId, inviteeUids, poke }),
    }).catch((err) => console.error('rummy13 invite failed:', err));
    if (!poke) setShowInvite(false);
  };

  const handleStart = async () => {
    await call('/api/rummy13/start', {}).catch(() => {});
  };

  const handleFillBot = async () => {
    await call('/api/rummy13/fill-bot', {}).catch(() => {});
  };

  const handleCopyCode = () => {
    navigator.clipboard?.writeText(table.code).catch(() => {});
  };

  const handleDrawStock = () =>
    call('/api/rummy13/draw', { source: 'stock' })
      .then((json) => setLastDrawnCard(json?.drawnCard || null))
      .catch(() => {});
  const handleDrawDiscard = () =>
    call('/api/rummy13/draw', { source: 'discard' })
      .then((json) => setLastDrawnCard(json?.drawnCard || null))
      .catch(() => {});

  const handleQuickDiscard = async (cardId: string) => {
    await call('/api/rummy13/discard', { cardId }).catch(() => {});
    setHandGroups((gs) => gs.map((g) => g.filter((c) => c !== cardId)).filter((g) => g.length > 0));
    setSelectedForGroup([]);
  };

  const looseForDeclare = handSorted.filter((c) => !handGroups.some((g) => g.includes(c)));
  const sequenceGroupsForDeclare = handGroups.filter((g) => isValidSequence(g, wildcardRanks).valid);
  const hasPureSequenceForDeclare = sequenceGroupsForDeclare.some((g) => isPureSequence(g));
  const allGroupsValidForDeclare = handGroups.length > 0 && handGroups.every((g) => isValidGroup(g, wildcardRanks).valid);
  const declareEnabled = isMyTurn && !meInDeal?.dropped && deal?.turnPhase === 'discard' && mode === 'none' && looseForDeclare.length === 1;
  const declareLooksValid = declareEnabled && sequenceGroupsForDeclare.length >= 2 && hasPureSequenceForDeclare && allGroupsValidForDeclare;

  const handleDeclare = async () => {
    if (!declareEnabled) return;
    if (!declareLooksValid) {
      if (!window.confirm('This doesn\'t look like a valid declaration (need at least 2 sequences, including 1 pure, with every group valid). Declaring anyway costs you 80 points if it\'s wrong. Declare anyway?')) return;
    }
    await call('/api/rummy13/declare', { discardCardId: looseForDeclare[0], groups: handGroups }).catch(() => {});
  };

  const handleRejoin = async () => {
    await call('/api/rummy13/rejoin', {}).catch(() => {});
  };

  // Showdown (someone declared): arrange for the fewest points automatically, or send the arrangement
  // currently on the table. The server scores what it's sent against the real hand.
  const handleAutoArrange = () => {
    const best = bestShowArrangement(handSorted, wildcardRanks);
    setHandGroups(best.groups);
    setSelectedForGroup([]);
  };
  const handleShow = async () => {
    await call('/api/rummy13/show', { groups: handGroups.filter((g) => g.length > 0) }).catch(() => {});
  };

  const handleDrop = async () => {
    const warning = isPool
      ? 'Drop out of this deal? It only ends this hand for you, not the whole table — you\'ll pick up a penalty for this deal.'
      : 'Drop out of this table? You cannot rejoin.';
    if (!window.confirm(warning)) return;
    await call('/api/rummy13/drop', {}).catch(() => {});
  };

  // Three distinct ways to leave this screen, offered as a menu rather than one button — "just
  // leave" keeps your seat untouched (no penalty), the other two both forfeit via the same /drop
  // endpoint Drop itself uses (with its own confirm dialog) before landing back on the lobby, which
  // doubles as the create-a-table screen.
  const handleGoToLobby = () => { setShowExitMenu(false); navigate('/games/rummy13'); };
  const handleQuitAndGoToLobby = async () => {
    setShowExitMenu(false);
    await handleDrop();
    navigate('/games/rummy13');
  };

  const handleDeleteTable = async () => {
    if (!window.confirm('Delete this table? This cannot be undone.')) return;
    try {
      await call('/api/rummy13/delete', {});
      navigate('/games/rummy13');
    } catch {
      // error already surfaced via `error` state
    }
  };

  const handlePlayAgain = async () => {
    try {
      const json = await call('/api/rummy13/rematch', {});
      if (json?.gameId) navigate(`/games/rummy13/${json.gameId}`);
    } catch {
      // error already surfaced via `error` state
    }
  };

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

  // Drag-and-drop moves: into another group, or back out to the loose cards.
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
    // Arranging cards (into / out of groups) is always allowed; only the discard needs your turn,
    // and not while another request of yours is still in flight.
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

  const getCardInteraction = (c: string): { selected: boolean; onClick?: () => void } => {
    return { selected: selectedForGroup.includes(c), onClick: !meInDeal?.dropped ? () => toggleForGroup(c) : undefined };
  };

  const visibleHandGroups = handGroups.map((g, idx) => ({ idx, cards: g })).filter((entry) => entry.cards.length > 0);
  const groupedCardIds = new Set(handGroups.flat());
  const handGridCards = handSorted.filter((c) => !groupedCardIds.has(c));

  // Card points: per group, and the overall total if the hand were declared right now. Declaring
  // needs at least two sequences with one of them pure; with that, valid groups count nothing and
  // only invalid groups + ungrouped cards score — without it EVERY card counts, valid groups
  // included. In the discard phase (14 cards) one ungrouped card is about to go out, so the
  // costliest ungrouped card is left out. Capped at 80, like every other penalty here.
  const pointsOf = (cards: string[]) => cards.reduce((sum, c) => sum + cardValue(c, wildcardRanks), 0);
  const ownGroupCards = visibleHandGroups.map((g) => g.cards);
  const declareStructureOk =
    ownGroupCards.filter((g) => isValidSequence(g, wildcardRanks).valid).length >= 2 && ownGroupCards.some((g) => isPureSequence(g));
  const declareCounted = declareStructureOk
    ? [...handGridCards, ...ownGroupCards.filter((g) => !isValidGroup(g, wildcardRanks).valid).flat()]
    : handSorted;
  let declarePoints = pointsOf(declareCounted);
  if (handSorted.length > 13 && handGridCards.length > 0) {
    declarePoints -= Math.max(...handGridCards.map((c) => cardValue(c, wildcardRanks)));
  }
  declarePoints = Math.min(Math.max(declarePoints, 0), 80);

  // ---- Waiting room ----
  if (table.status === 'waiting') {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <ReactionOverlay reactions={floatingReactions} />
        <header className="p-4 flex items-center gap-3 bg-white border-b border-border-subtle">
          <h1 className="font-black text-primary">13-Card Rummy</h1>
          <ReactionButton onSend={handleSendReaction} />
          <div className="flex items-center gap-1 ml-auto">
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
          {showHelp && <GameHelpModal content={RUMMY13_HELP} onClose={() => setShowHelp(false)} />}
        </header>
        {showChat && user && (
          <ChatPanel
            collectionName="rummy13Tables"
            gameId={tableId}
            messages={chatMessages}
            loading={chatLoading}
            myUid={user.uid}
            myDisplayName={profile?.displayName || user.displayName || 'Player'}
            myPhotoURL={profile?.photoURL || user.photoURL || ''}
            otherUids={table.players.filter((p) => p.uid !== user.uid).map((p) => p.uid)}
            onClose={() => setShowChat(false)}
          />
        )}
        <main className="flex-1 p-4 max-w-xl mx-auto w-full space-y-5 pb-24">
          <div className="bg-white rounded-2xl border border-border-subtle p-5 flex items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">
                Share code · {FORMAT_LABEL[table.format]} · {table.maxPlayers} players
              </p>
              <p className="text-2xl font-black text-primary tracking-widest">{table.code}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={handleCopyCode} className="px-3 py-2 bg-primary/10 text-primary rounded-xl text-xs font-bold flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">content_copy</span> Copy
              </button>
              <ShareGameButton
                gameLabel="13-Card Rummy"
                code={table.code}
                path={`/games/rummy13/${tableId}`}
                className="px-3 py-2 bg-[#25D366] text-white rounded-xl text-xs font-bold flex items-center gap-1"
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
            {table.players.map((p) => (
              <div key={p.uid} className="p-4 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold overflow-hidden">
                  {p.isBot ? '🤖' : avatarSrcFor(p.uid, p.photoURL) ? (
                    <img src={avatarSrcFor(p.uid, p.photoURL)} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    p.displayName?.slice(0, 1) || '?'
                  )}
                </div>
                <p className="text-sm font-bold text-on-surface">{p.displayName}</p>
                {p.uid === table.hostUid && <span className="ml-auto text-[10px] font-bold text-primary uppercase">Host</span>}
              </div>
            ))}
            {Array.from({ length: Math.max(0, 2 - table.players.length) }).map((_, i) => (
              <div key={i} className="p-4 flex items-center gap-3 opacity-40">
                <div className="w-9 h-9 rounded-full border-2 border-dashed border-border-subtle" />
                <p className="text-sm text-text-muted italic">Waiting for player…</p>
              </div>
            ))}
          </div>

          {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

          {!isPlayer && table.players.length < table.maxPlayers && (
            <button onClick={handleJoinTable} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">
              Join Table
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
            <InvitePicker groupIds={groupIds} alreadyIn={table.players.map((p) => p.uid)} onInvite={handleInvite} extraCandidates={friendCandidates} />
          )}

          {isPlayer && user.uid === table.hostUid && table.players.length < table.maxPlayers && (
            <button
              onClick={handleFillBot}
              disabled={busy}
              className="w-full py-2.5 border border-border-subtle text-text-muted font-bold rounded-xl text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">smart_toy</span>
              Fill Empty Seat with Bot
            </button>
          )}

          {isPlayer && user.uid === table.hostUid ? (
            <button
              onClick={handleStart}
              disabled={busy || table.players.length < 2}
              className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
            >
              {table.players.length < 2 ? 'Need at least 2 players' : busy ? 'Starting…' : 'Start Table'}
            </button>
          ) : isPlayer ? (
            <p className="text-center text-sm text-text-muted italic">Waiting for the host to start the table…</p>
          ) : null}

          {isPlayer && user.uid === table.hostUid && (
            <button onClick={handleDeleteTable} className="w-full py-2.5 text-error/70 font-bold text-sm">
              Delete Table
            </button>
          )}
        </main>
      </div>
    );
  }

  // ---- Finished ----
  if (table.status === 'finished') {
    const winner = table.players.find((p) => p.uid === table.winnerUid);
    const revealed = deal?.revealedHands;
    const revealWildcardRanks = withPrintedJoker(deal?.wildJokerRank ? [deal.wildJokerRank as Rank] : []);
    const standings = [...table.players].sort((a, b) => a.cumulativeScore - b.cumulativeScore);

    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <ReactionOverlay reactions={floatingReactions} />
        <div className="relative shrink-0 bg-primary/5 border-b border-border-subtle px-4 py-4 text-center overflow-hidden">
          <Fireworks />
          <span className="relative text-4xl">🏆</span>
          <div className="relative flex items-center justify-center gap-2 mt-1">
            <h1 className="text-lg font-black text-primary">{winner ? `${winner.displayName} wins!` : 'Table over'}</h1>
            <ReactionButton onSend={handleSendReaction} />
          </div>
          {error && <p className="relative text-xs font-bold text-error mt-1">{error}</p>}
          <div className="relative flex items-center gap-2 mt-3">
            {isPlayer && (
              <button
                onClick={() => (table.rematchGameId ? navigate(`/games/rummy13/${table.rematchGameId}`) : handlePlayAgain())}
                disabled={busy}
                className="flex-1 py-2.5 bg-success text-white font-bold rounded-2xl disabled:opacity-50 text-sm"
              >
                {table.rematchGameId ? 'Join Rematch' : busy ? 'Starting…' : 'Play Again'}
              </button>
            )}
            <button onClick={() => navigate('/tools?category=games')} className="flex-1 py-2.5 bg-primary text-white font-bold rounded-2xl text-sm">
              Back to Games
            </button>
            {user.uid === table.hostUid && (
              <button onClick={handleDeleteTable} className="p-2.5 bg-white rounded-2xl border border-border-subtle text-error/70 shrink-0" aria-label="Delete table">
                <span className="material-symbols-outlined text-[20px] block">delete</span>
              </button>
            )}
          </div>
        </div>

        <main className="flex-1 overflow-y-auto p-4 space-y-4">
          {isPool && (
            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-1.5">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Final Standings</p>
              {standings.map((p, i) => (
                <div key={p.uid} className="flex items-center gap-2 px-1 py-1">
                  <span className="text-xs font-black text-text-muted w-4">{i + 1}</span>
                  <span className={`text-sm font-bold flex-1 ${p.uid === table.winnerUid ? 'text-success' : 'text-on-surface'}`}>
                    {p.displayName}{p.uid === user.uid ? ' (You)' : ''}
                  </span>
                  <span className="text-xs font-bold text-text-muted">{p.cumulativeScore} pts</span>
                </div>
              ))}
            </div>
          )}

          {(table.players || []).map((p) => {
            const rev = revealed?.[p.uid];
            const isWinner = p.uid === table.winnerUid;
            const dealPts = deal?.dealScores?.[p.uid];
            return (
              <div key={p.uid} className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-black flex-1 ${isWinner ? 'text-success' : 'text-on-surface'}`}>
                    {isWinner ? '🏆 ' : ''}{p.displayName}
                    {p.uid === user.uid ? ' (You)' : ''}
                  </span>
                  {dealPts != null && (
                    <span className={`text-xs font-black shrink-0 ${dealPts === 0 ? 'text-success' : 'text-error'}`}>
                      {dealPts === 0 ? '0 pts' : `+${dealPts} pts`}
                    </span>
                  )}
                </div>
                {!rev ? (
                  <p className="text-xs text-text-muted italic">Hand not available.</p>
                ) : rev.declaredGroups ? (
                  <div className="space-y-1.5">
                    {rev.declaredGroups.map((g, i) => (
                      <GroupRow key={i} cardIds={g.cards} valid label={`Group ${i + 1}`} wildcardRanks={revealWildcardRanks} />
                    ))}
                    {rev.discardCardId && <GroupRow cardIds={[rev.discardCardId]} label="Discarded to Win" wildcardRanks={revealWildcardRanks} />}
                  </div>
                ) : (rev.groups || []).some((g) => g.cards.length > 0) ? (
                  (() => {
                    // The player's OWN grouping as they left it — each group marked valid/invalid —
                    // with whatever they hadn't grouped shown separately.
                    const inHand = new Set(rev.cards);
                    const ownGroups = (rev.groups || []).map((g) => g.cards.filter((c) => inHand.has(c))).filter((g) => g.length > 0);
                    const grouped = new Set(ownGroups.flat());
                    const ungrouped = sortHandForDisplay(rev.cards.filter((c) => !grouped.has(c)));
                    return (
                      <div className="space-y-1.5">
                        {ownGroups.map((g, i) => (
                          <GroupRow key={i} cardIds={g} valid={isValidGroup(g, revealWildcardRanks).valid} label={`Group ${i + 1}`} wildcardRanks={revealWildcardRanks} />
                        ))}
                        {ungrouped.length > 0 && (
                          <GroupRow cardIds={ungrouped} label={`Ungrouped (${ungrouped.length})`} wildcardRanks={revealWildcardRanks} />
                        )}
                      </div>
                    );
                  })()
                ) : (
                  (() => {
                    const { penalty, protectedCardIds } = computeRummy13HandPenalty(rev.cards, revealWildcardRanks);
                    const protectedSet = new Set(protectedCardIds);
                    const protectedCards = sortHandForDisplay(rev.cards.filter((c) => protectedSet.has(c)));
                    const penalizedCards = sortHandForDisplay(rev.cards.filter((c) => !protectedSet.has(c)));
                    return (
                      <div className="space-y-1.5">
                        <p className="text-[10px] text-text-muted px-0.5">Best possible grouping of this hand — minimizes the penalty:</p>
                        {protectedCards.length > 0 && (
                          <GroupRow cardIds={protectedCards} valid label="Protected (0 pts)" wildcardRanks={revealWildcardRanks} />
                        )}
                        {penalizedCards.length > 0 && (
                          <GroupRow cardIds={penalizedCards} label={`Penalized (${penalty} pts)`} wildcardRanks={revealWildcardRanks} />
                        )}
                      </div>
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

  // ---- Active ----
  if (!deal) return <div className="p-8 text-center text-text-muted">Loading deal…</div>;

  const topDiscard = deal.discardPile[deal.discardPile.length - 1] || null;
  const topDiscardRank = topDiscard ? parseCard(topDiscard).rank : null;
  const topDiscardIsWildForMe = topDiscardRank !== null && wildcardRanks.includes(topDiscardRank as Rank);
  const canAct = isMyTurn && !meInDeal?.dropped && mode === 'none';
  const canDrawDiscard = canAct && deal.turnPhase === 'draw' && !!topDiscard && !busy;
  const canDrawStock = canAct && deal.turnPhase === 'draw';
  const canDiscardNow = canAct && deal.turnPhase === 'discard';

  // Showdown: a valid declaration was made and everyone else is arranging + showing their cards.
  const showdown = deal.turnPhase === 'showdown' ? deal.showdown || null : null;
  const iAmDeclarer = !!showdown && showdown.declarerUid === user.uid;
  const mySubmission = showdown?.submitted?.[user.uid] || null;
  const needToShow = !!showdown && !iAmDeclarer && !meInDeal?.dropped && !mySubmission;
  const declarerName = showdown ? (iAmDeclarer ? 'You' : table.players.find((tp) => tp.uid === showdown.declarerUid)?.displayName || 'Someone') : '';
  const waitingOn = showdown
    ? deal.players
        .filter((p) => !p.dropped && p.uid !== showdown.declarerUid && !showdown.submitted?.[p.uid])
        .map((p) => (p.uid === user.uid ? 'you' : table.players.find((tp) => tp.uid === p.uid)?.displayName || '…'))
    : [];

  const turnStatusText = meInDeal?.dropped
    ? 'You are out of this deal'
    : showdown
    ? needToShow
      ? `${declarerName} declared — arrange your cards and show them`
      : `${declarerName} declared — waiting for ${waitingOn.join(', ') || 'everyone'}`
    : isMyTurn
    ? deal.turnPhase === 'draw'
      ? 'Your turn — draw'
      : 'Your turn — discard'
    : `${table.players.find((tp) => tp.uid === deal.players[deal.currentTurnSeatIndex]?.uid)?.displayName || '…'}'s turn`;

  const timerWarning = remainingSec !== null && remainingSec <= TURN_WARNING_MS / 1000;

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <ReactionOverlay reactions={floatingReactions} />

      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[260] max-w-[92vw] pointer-events-none">
        <AnimatePresence>
          {dealEndedToast && (
            <motion.div
              key={dealEndedToast.dealNumber}
              initial={{ y: -50, opacity: 0, scale: 0.85 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: -40, opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', damping: 16, stiffness: 260 }}
              className="bg-primary text-white text-xs font-bold pl-2.5 pr-4 py-2.5 rounded-2xl shadow-xl flex flex-col gap-1 max-w-xs"
            >
              <span>
                {dealEndedToast.invalidDeclareUid
                  ? 'Invalid declaration — deal over.'
                  : dealEndedToast.winnerUid
                  ? `${table.players.find((p) => p.uid === dealEndedToast.winnerUid)?.displayName || 'Someone'} won this deal!`
                  : 'Deal ended.'}
              </span>
              {isPool && (
                <span className="text-[10px] font-medium text-white/80">
                  {Object.entries(dealEndedToast.dealScores).map(([uid, pts]) => `${table.players.find((p) => p.uid === uid)?.displayName || '…'} +${pts}`).join(' · ')}
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {showHelp && <GameHelpModal content={RUMMY13_HELP} onClose={() => setShowHelp(false)} />}
      {showChat && user && (
        <ChatPanel
          collectionName="rummy13Tables"
          gameId={tableId}
          messages={chatMessages}
          loading={chatLoading}
          myUid={user.uid}
          myDisplayName={profile?.displayName || user.displayName || 'Player'}
          myPhotoURL={profile?.photoURL || user.photoURL || ''}
          otherUids={table.players.filter((p) => p.uid !== user.uid).map((p) => p.uid)}
          onClose={() => setShowChat(false)}
        />
      )}

      {showExitMenu && (
        <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowExitMenu(false)}>
          <div className="w-full max-w-xs bg-white rounded-3xl shadow-2xl p-4 space-y-2" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-bold text-text-muted uppercase tracking-wider text-center pb-1">Leave this table?</p>
            <button onClick={handleGoToLobby} className="w-full py-3 bg-surface rounded-2xl text-sm font-bold text-on-surface text-left px-4">
              <span className="block">Go to Lobby</span>
              <span className="block text-[10px] font-medium text-text-muted mt-0.5">Keeps your seat — come back anytime</span>
            </button>
            <button onClick={handleQuitAndGoToLobby} className="w-full py-3 bg-surface rounded-2xl text-sm font-bold text-error text-left px-4">
              <span className="block">Quit &amp; Start New Game</span>
              <span className="block text-[10px] font-medium text-text-muted mt-0.5">Forfeits this table, lands you on the create-table screen</span>
            </button>
            <button onClick={handleQuitAndGoToLobby} className="w-full py-3 bg-surface rounded-2xl text-sm font-bold text-error text-left px-4">
              <span className="block">Quit &amp; Go to Lobby</span>
              <span className="block text-[10px] font-medium text-text-muted mt-0.5">Forfeits this table, back to the games list</span>
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
        {/* Only exists while the phone is held upright (the `portrait:` variant) — turning it
            sideways makes it disappear on its own. */}
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
              <p className="text-sm text-white/80">13-Card Rummy plays best in landscape — your whole hand fits in one row.</p>
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
            <h1 className="font-black text-primary text-xs">13-Card Rummy</h1>
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{table.code} · {FORMAT_LABEL[table.format]}</span>
          </div>
          <ReactionButton onSend={handleSendReaction} />
          <p className={`flex-1 min-w-0 truncate text-center text-[11px] font-bold ${isMyTurn ? 'text-primary' : 'text-text-muted'}`}>
            {turnStatusText}
            {remainingSec !== null && (
              <span className={`ml-2 text-[11px] font-black px-1.5 py-0.5 rounded-full ${timerWarning ? 'bg-error/10 text-error animate-pulse' : 'text-text-muted'}`}>
                {remainingSec}s
              </span>
            )}
          </p>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={handleDrop} disabled={busy || meInDeal?.dropped || !!showdown} className="p-1.5 text-error shrink-0 disabled:opacity-30" aria-label="Drop">
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
          <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2 [--cw:min(15vw,3.75rem)] landscape:[--cw:min(9vw,17vh,3.75rem)]">
            {/* Felt table: wooden rim, green baize with a soft spotlight. Seats along the top (avatar,
                name, score/hand size); the discard pile in the middle, the wild card bottom-left and
                the draw deck bottom-right. */}
            <div
              ref={tableDropRef}
              className={`relative flex-1 min-h-[9rem] flex flex-col rounded-[1.5rem] border-[5px] p-2 gap-1 overflow-hidden transition-all shadow-[inset_0_0_36px_rgba(0,0,0,0.5),0_6px_16px_rgba(0,0,0,0.25)] bg-[radial-gradient(ellipse_at_center,#1f7a5a_0%,#165c44_55%,#0e3f2f_100%)] ${
                isDraggingCard && canDiscardNow ? 'border-amber-300 ring-4 ring-amber-300/40' : 'border-[#4a3322]'
              }`}
            >
              <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-[9rem] leading-none text-white/[0.05] select-none">♠</span>
              <div className="relative shrink-0 flex items-stretch justify-center gap-1.5 flex-wrap">
                {deal.players.map((p, i) => {
                  const tp = table.players.find((x) => x.uid === p.uid);
                  const isTurn = !showdown && i === deal.currentTurnSeatIndex && !p.dropped;
                  return (
                    <div
                      key={p.uid}
                      className={`flex items-center gap-1.5 w-[min(30vw,8.5rem)] rounded-xl px-1.5 py-1 backdrop-blur-sm transition-colors ${
                        isTurn ? 'bg-amber-300/15 ring-1 ring-amber-300/60' : 'bg-black/20'
                      } ${p.dropped || tp?.eliminated ? 'opacity-45' : ''}`}
                    >
                      <div className={`relative w-8 h-8 shrink-0 rounded-full bg-emerald-950 flex items-center justify-center text-white text-xs font-bold ${isTurn ? 'ring-2 ring-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.85)]' : 'ring-1 ring-white/30'}`}>
                        <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center">
                          {tp?.isBot ? (
                            <span className="text-base leading-none">🤖</span>
                          ) : avatarSrcFor(p.uid, tp?.photoURL) ? (
                            <img src={avatarSrcFor(p.uid, tp?.photoURL)} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            tp?.displayName?.slice(0, 1) || '?'
                          )}
                        </div>
                        <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2 h-2" />
                      </div>
                      <div className="flex flex-col min-w-0 leading-tight">
                        <span className={`text-[10px] font-semibold truncate ${isTurn ? 'text-amber-200' : 'text-white'}`}>
                          {p.uid === user.uid ? 'You' : tp?.displayName || '…'}
                        </span>
                        {isPool && tp && (
                          <span className="text-[10px] font-black text-amber-300 whitespace-nowrap">
                            {tp.cumulativeScore}{table.poolLimit ? <span className="text-white/50 font-bold">/{table.poolLimit}</span> : null}
                          </span>
                        )}
                        <span className="text-[9px] whitespace-nowrap text-emerald-100/80">
                          {p.dropped
                            ? 'out'
                            : tp?.eliminated
                            ? 'eliminated'
                            : showdown
                            ? p.uid === showdown.declarerUid
                              ? 'declared ✓'
                              : showdown.submitted?.[p.uid]
                              ? 'shown ✓'
                              : 'arranging…'
                            : `${p.handCount} cards`}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="relative flex-1 min-h-[6.5rem]">
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                  <span className="text-[9px] font-bold text-emerald-100/70 uppercase tracking-widest">Discard</span>
                  {topDiscard ? (
                    <div className={`rounded-lg drop-shadow-[0_3px_5px_rgba(0,0,0,0.45)] ${canDrawDiscard ? 'ring-4 ring-amber-300/70 animate-pulse' : ''}`}>
                      <CardChip cardId={topDiscard} dim={isMyTurn && deal.turnPhase === 'draw' && !canDrawDiscard} onClick={canDrawDiscard ? handleDrawDiscard : undefined} wildcardRanks={wildcardRanks} />
                    </div>
                  ) : (
                    <div className="w-[min(14vw,3.75rem)] landscape:w-[min(14vh,3.25rem)] aspect-[5/7] rounded-lg border-2 border-dashed border-white/25 bg-black/10" />
                  )}
                </div>

                {deal.wildJokerIndicatorCard && (
                  <div className="absolute bottom-0 left-1 flex flex-col items-center gap-1">
                    <span className="text-[9px] font-bold text-emerald-100/70 uppercase tracking-widest">Wild</span>
                    <div className="drop-shadow-[0_3px_5px_rgba(0,0,0,0.45)]"><CardChip cardId={deal.wildJokerIndicatorCard} /></div>
                  </div>
                )}

                <div className="absolute bottom-0 right-2 flex flex-col items-center gap-1">
                  <span className="text-[9px] font-bold text-emerald-100/70 uppercase tracking-widest">Draw · {deal.stockCount}</span>
                  {/* A small stacked deck: two card edges peek out behind the top card. */}
                  <div className={`relative ${canDrawStock ? 'animate-pulse' : 'opacity-70'}`}>
                    <div className="absolute inset-0 translate-x-1.5 translate-y-1.5 rounded-lg border-2 border-white/40 bg-[#0b2f45] shadow-md" />
                    <div className="absolute inset-0 translate-x-[3px] translate-y-[3px] rounded-lg border-2 border-white/50 bg-[#0f4761] shadow-md" />
                    <div className={`relative rounded-lg drop-shadow-[0_3px_5px_rgba(0,0,0,0.45)] ${canDrawStock ? 'ring-4 ring-amber-300/70' : ''}`}>
                      <CardChip cardId="AS" faceDown onClick={canDrawStock && !busy ? handleDrawStock : undefined} />
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
                    <div className="flex">
                      {cards.map((c, i) => {
                        const isLast = i === n - 1;
                        const { selected, onClick } = getCardInteraction(c);
                        return (
                          <div key={`${c}-${i}`} className={isLast ? 'shrink-0' : 'flex-1 min-w-0 max-w-[var(--cw)]'}>
                            <DraggableCard enabled={!meInDeal?.dropped} draggedFlag={cardWasDragged} onDragState={setIsDraggingCard} onDrop={(r) => handleCardDrop(c, r)}>
                              <CardChip
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
                      })}
                    </div>
                    <div className={`mt-1 h-1 rounded-full ${valid ? 'bg-success' : 'bg-text-muted/40'}`} />
                    <div className="flex items-center justify-center gap-1 mt-0.5">
                      <span className={`text-[10px] font-black leading-none ${valid ? 'text-success' : 'text-text-muted'}`}>
                        {pointsOf(cards)}<span className="text-[8px] font-bold"> pts</span>
                      </span>
                      {mode === 'none' && (
                        <button
                          onClick={() => setHandGroups((gs) => gs.filter((_, gi) => gi !== idx))}
                          aria-label="Ungroup"
                          className="w-5 h-5 rounded-full bg-white border border-border-subtle shadow-sm flex items-center justify-center text-text-muted"
                        >
                          <span className="material-symbols-outlined text-[13px] leading-none">close</span>
                        </button>
                      )}
                      {mode === 'none' && !meInDeal?.dropped && selectedForGroup.length > 0 && (
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
                  <div className="flex">
                  {handGridCards.map((c, idx) => {
                    const { selected, onClick } = getCardInteraction(c);
                    const isLast = idx === handGridCards.length - 1;
                    return (
                      <div key={`${c}-${idx}`} className={isLast ? 'shrink-0' : 'flex-1 min-w-0 max-w-[var(--cw)]'}>
                        <DraggableCard enabled={!meInDeal?.dropped} draggedFlag={cardWasDragged} onDragState={setIsDraggingCard} onDrop={(r) => handleCardDrop(c, r)}>
                          <CardChip
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
                  })}
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-text-muted/20" />
                  <p className="mt-0.5 text-center text-[10px] font-black leading-none text-text-muted">
                    {pointsOf(handGridCards)}<span className="text-[8px] font-bold"> pts</span>
                  </p>
                </div>
              )}
            </div>

          </div>

          <aside className="landscape:w-40 landscape:shrink-0 flex flex-row landscape:flex-col flex-wrap items-center landscape:items-stretch gap-1.5 landscape:overflow-y-auto">
            {error && <p className="text-xs font-bold text-error w-full">{error}</p>}

            {showdown && (
              <div className="w-full rounded-xl border border-amber-400/60 bg-amber-50 p-2 space-y-1.5">
                <p className="text-[11px] font-black text-on-surface">{declarerName === 'You' ? 'You declared!' : `${declarerName} declared!`}</p>
                {needToShow ? (
                  <>
                    <p className="text-[10px] text-text-muted leading-snug">
                      Arrange your cards for the fewest points, then show them{remainingSec !== null ? ` — ${remainingSec}s left` : ''}.
                    </p>
                    <button
                      onClick={handleAutoArrange}
                      className="w-full py-1.5 rounded-lg bg-primary/10 text-primary text-[11px] font-bold flex items-center justify-center gap-1"
                    >
                      <span className="material-symbols-outlined text-[15px]">auto_fix_high</span>
                      Auto-arrange (fewest points)
                    </button>
                    <button
                      onClick={handleShow}
                      disabled={busy}
                      className="w-full py-2 rounded-lg bg-success text-white text-xs font-bold disabled:opacity-50"
                    >
                      {busy ? 'Showing…' : `Show my cards · ${declarePoints} pts`}
                    </button>
                  </>
                ) : mySubmission ? (
                  <p className="text-[10px] text-text-muted leading-snug">
                    Your cards are shown — <span className="font-bold text-error">{mySubmission.score} pts</span>. Waiting for {waitingOn.join(', ') || 'everyone'}…
                  </p>
                ) : iAmDeclarer ? (
                  <p className="text-[10px] text-text-muted leading-snug">Waiting for {waitingOn.join(', ') || 'everyone'} to show their cards…</p>
                ) : null}
              </div>
            )}

            {meInDeal?.dropped && (
              <div className="w-full rounded-xl border border-success/40 bg-success/10 p-2 space-y-1.5">
                {meInDeal.rejoined ? (
                  <p className="text-[11px] font-bold text-text-muted">You've already rejoined this deal once, so you're sitting out the rest of it.</p>
                ) : (
                  <>
                    <p className="text-[11px] font-bold text-on-surface">Want back in?</p>
                    <p className="text-[10px] text-text-muted leading-snug">You keep your hand and rejoin the turn order. The drop penalty stays, and you can rejoin once per deal.</p>
                    <button
                      onClick={handleRejoin}
                      disabled={busy}
                      className="w-full py-2 bg-success text-white rounded-lg text-xs font-bold disabled:opacity-50 flex items-center justify-center gap-1"
                    >
                      <span className="material-symbols-outlined text-[16px]">login</span>
                      {busy ? 'Rejoining…' : 'Rejoin this deal'}
                    </button>
                  </>
                )}
              </div>
            )}

            {mode === 'none' && !meInDeal?.dropped && (
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

            {isMyTurn && !meInDeal?.dropped && deal.turnPhase === 'discard' && mode === 'none' && (
              <div className="flex flex-col gap-1 landscape:w-full">
                <button
                  onClick={handleDeclare}
                  disabled={!declareEnabled || busy}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-30 ${declareLooksValid ? 'bg-success text-white' : 'bg-warning/20 text-warning'}`}
                >
                  Declare
                </button>
                {!declareEnabled ? (
                  <span className="text-[10px] text-text-muted">{looseForDeclare.length} card(s) ungrouped — need exactly 1</span>
                ) : !declareLooksValid ? (
                  <span className="text-[10px] text-warning">grouping looks invalid — declaring costs 80 pts if wrong</span>
                ) : null}
              </div>
            )}

            {!meInDeal?.dropped && handSorted.length > 0 && (!showdown || needToShow) && (
              <div className="w-full rounded-lg border border-border-subtle bg-white p-1.5 text-[10px] leading-snug">
                <p className="font-bold">
                  <span className="text-text-muted">{showdown ? 'If you show now: ' : 'If you declare now: '}</span>
                  <span className={declarePoints === 0 ? 'text-success' : 'text-error'}>{declarePoints} pts</span>
                </p>
                {!declareStructureOk && (
                  <p className="text-text-muted mt-0.5">Needs 2 sequences with 1 pure — until then every card counts, even valid groups.</p>
                )}
              </div>
            )}

            <p className="text-[10px] text-text-muted italic landscape:mt-auto">
              Your hand ({handSorted.length}) ·{' '}
              {canDiscardNow ? 'drag a card onto the table to discard it, or into a group to organize' : 'drag cards between groups, or tap to select and group them'}
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}
