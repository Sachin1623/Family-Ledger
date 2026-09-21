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
  isPrintedJoker,
  withPrintedJoker,
  SUIT_SYMBOL,
  SUIT_RED,
  isPureSequence,
  isValidSequence,
  isValidGroup,
  sortHandForDisplay,
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
import { useGameTurnPresence } from '../../lib/gameTurnPresence';

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
  size?: 'played' | 'group';
  wildcardRanks?: string[];
}> = ({ cardId, selected, dim, highlight, faceDown, onClick, size, wildcardRanks }) => {
  const joker = isPrintedJoker(cardId);
  const { rank, suit } = parseCard(cardId);
  const red = !joker && SUIT_RED[suit];
  const dims = size === 'played' ? 'w-[27px] h-9 text-[9px]' : size === 'group' ? 'w-[31px] h-[41px] text-[10px]' : 'w-9 h-12 text-[11px]';
  const isWild = !faceDown && !joker && !!wildcardRanks?.includes(rank as Rank);
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
      } ${dim ? 'opacity-40' : ''} ${faceDown ? 'bg-primary text-white' : joker ? 'text-warning' : red ? 'text-error' : 'text-on-surface'}`}
    >
      {isWild && (
        <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-warning text-white flex items-center justify-center shadow">
          <span className="material-symbols-outlined text-[9px] leading-none">auto_awesome</span>
        </span>
      )}
      {faceDown ? (
        <span className="material-symbols-outlined rotate-180 text-[18px]">style</span>
      ) : joker ? (
        <span className="text-base leading-none">🃏</span>
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
  wildcardRanks?: string[];
}> = ({ cardIds, valid, label, onRemove, onCardClick, selectedIds, highlightId, onAddSelected, addSelectedCount, wildcardRanks }) => {
  return (
    <div className={`relative p-1.5 rounded-lg border ${valid ? 'border-success bg-success/5' : 'border-border-subtle bg-surface'}`}>
      {label && <span className="text-[10px] font-bold text-text-muted uppercase block mb-1">{label}</span>}
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

  const shownPointsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!tableId || !user || table?.status !== 'finished') return;
    if (shownPointsRef.current.has(tableId)) return;
    shownPointsRef.current.add(tableId);
    showGamePointsIfAny('rummy13', tableId);
  }, [tableId, user, table?.status]);

  useGameTurnPresence('rummy13', tableId);

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
  const [mode] = useState<SelectionMode>('none');
  const [handGroups, setHandGroups] = useState<string[][]>([]);
  const [selectedForGroup, setSelectedForGroup] = useState<string[]>([]);
  const [lastDrawnCard, setLastDrawnCard] = useState<string | null>(null);

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

  const handleDrop = async () => {
    const warning = isPool
      ? 'Drop out of this deal? It only ends this hand for you, not the whole table — you\'ll pick up a penalty for this deal.'
      : 'Drop out of this table? You cannot rejoin.';
    if (!window.confirm(warning)) return;
    await call('/api/rummy13/drop', {}).catch(() => {});
  };

  const handleDeleteTable = async () => {
    if (!window.confirm('Delete this table? This cannot be undone.')) return;
    try {
      await call('/api/rummy13/delete', {});
      navigate('/tools?category=games');
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
                <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold">
                  {p.displayName?.slice(0, 1) || '?'}
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
            return (
              <div key={p.uid} className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-black ${isWinner ? 'text-success' : 'text-on-surface'}`}>
                    {isWinner ? '🏆 ' : ''}{p.displayName}
                    {p.uid === user.uid ? ' (You)' : ''}
                  </span>
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
                ) : (
                  (() => {
                    const groupedCards = new Set((rev.groups || []).flatMap((g) => g.cards));
                    const ungrouped = rev.cards.filter((c) => !groupedCards.has(c));
                    const hasGroups = (rev.groups || []).some((g) => g.cards.length > 0);
                    return hasGroups ? (
                      <div className="space-y-1.5">
                        {(rev.groups || []).filter((g) => g.cards.length > 0).map((g, i) => (
                          <GroupRow key={i} cardIds={g.cards} label={`Group ${i + 1}`} wildcardRanks={revealWildcardRanks} />
                        ))}
                        {ungrouped.length > 0 && <GroupRow cardIds={sortHandForDisplay(ungrouped)} label="Ungrouped" wildcardRanks={revealWildcardRanks} />}
                      </div>
                    ) : (
                      <GroupRow cardIds={sortHandForDisplay(rev.cards)} label="Final Hand" wildcardRanks={revealWildcardRanks} />
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

  const turnStatusText = meInDeal?.dropped
    ? 'You dropped this deal'
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

      <div className="fixed inset-x-0 top-[calc(60px+env(safe-area-inset-top))] bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 flex flex-col bg-surface overflow-hidden">
        <div className="shrink-0">
        <header className="p-2 flex items-center gap-2 bg-white border-b border-border-subtle">
          <div className="flex flex-col leading-tight">
            <h1 className="font-black text-primary text-xs">13-Card Rummy</h1>
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{table.code} · {FORMAT_LABEL[table.format]}</span>
          </div>
          <ReactionButton onSend={handleSendReaction} />
          <div className="flex items-center gap-1.5 ml-auto">
            <button onClick={handleDrop} disabled={busy || meInDeal?.dropped} className="p-2 text-error shrink-0 disabled:opacity-30" aria-label="Leave deal">
              <span className="material-symbols-outlined text-[22px] block">logout</span>
            </button>
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
        </header>

        <div className="p-2 max-w-xl mx-auto w-full space-y-2">
          {isPool && (
            <div className="flex items-center gap-1.5 overflow-x-auto bg-white rounded-xl border border-border-subtle p-1.5">
              {table.players.map((p) => (
                <div key={p.uid} className={`flex items-center gap-1 px-1.5 py-0.5 rounded-lg shrink-0 ${p.eliminated ? 'opacity-40' : ''}`}>
                  <span className="text-[10px] font-bold text-on-surface whitespace-nowrap">{p.uid === user.uid ? 'You' : p.displayName}</span>
                  <span className="text-[10px] font-black text-primary whitespace-nowrap">{p.cumulativeScore}</span>
                  {p.eliminated && <span className="text-[8px] font-bold text-error uppercase">out</span>}
                </div>
              ))}
            </div>
          )}

          <div className="bg-white rounded-xl border border-border-subtle p-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <p className={`text-[11px] font-bold ${isMyTurn ? 'text-primary' : 'text-text-muted'}`}>{turnStatusText}</p>
              {remainingSec !== null && (
                <span className={`text-[11px] font-black px-1.5 py-0.5 rounded-full ${timerWarning ? 'bg-error/10 text-error animate-pulse' : 'text-text-muted'}`}>
                  {remainingSec}s
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto">
              {deal.players.map((p, i) => (
                <div
                  key={p.uid}
                  className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border shrink-0 ${
                    i === deal.currentTurnSeatIndex ? 'border-primary bg-primary/5' : 'border-border-subtle'
                  } ${p.dropped ? 'opacity-40' : ''}`}
                >
                  <div className="relative w-5 h-5 shrink-0">
                    <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center text-white text-[9px] font-bold">
                      {p.uid ? (table.players.find((tp) => tp.uid === p.uid)?.displayName?.slice(0, 1) || '?') : '?'}
                    </div>
                    <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2 h-2" />
                  </div>
                  <span className="text-[10px] font-bold text-on-surface whitespace-nowrap">
                    {p.uid === user.uid ? 'You' : table.players.find((tp) => tp.uid === p.uid)?.displayName || '…'}
                  </span>
                  <span className="text-[9px] text-text-muted whitespace-nowrap">{p.dropped ? 'out' : p.handCount}</span>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 pt-1.5 border-t border-border-subtle overflow-x-auto">
              {deal.wildJokerIndicatorCard && (
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[9px] font-bold text-text-muted uppercase">Wild</span>
                  <CardChip cardId={deal.wildJokerIndicatorCard} />
                </div>
              )}
              <div className="w-px self-stretch bg-border-subtle shrink-0" />
              <div
                className={`flex items-center gap-1.5 shrink-0 rounded-lg px-1.5 py-1 -my-1 transition-colors ${
                  isMyTurn && !meInDeal?.dropped ? 'bg-sky-200 animate-pulse' : ''
                }`}
              >
                <p className="text-[9px] font-bold text-text-muted uppercase leading-tight whitespace-nowrap">Discard</p>
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
                Draw {deal.stockCount}
              </button>
            </div>

            {mode === 'none' && !meInDeal?.dropped && (
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

          {isMyTurn && !meInDeal?.dropped && deal.turnPhase === 'discard' && mode === 'none' && (
            <div className="flex flex-wrap items-center gap-1.5">
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

          <div className="flex items-center justify-between px-1 gap-2 flex-wrap">
            <p className="text-[10px] font-bold text-text-muted uppercase">Your Hand ({handSorted.length})</p>
            {mode === 'none' &&
              !meInDeal?.dropped &&
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
                onAddSelected={mode === 'none' && !meInDeal?.dropped && selectedForGroup.length > 0 ? () => handleAddSelectedToGroup(idx) : undefined}
                addSelectedCount={selectedForGroup.length}
                wildcardRanks={wildcardRanks}
              />
            ))}
          </div>

          <div className="flex gap-1.5 flex-wrap">
            {handGridCards.map((c, idx) => {
              const { selected, onClick } = getCardInteraction(c);
              return <CardChip key={`${c}-${idx}`} cardId={c} selected={selected} highlight={c === lastDrawnCard} onClick={onClick} wildcardRanks={wildcardRanks} />;
            })}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
