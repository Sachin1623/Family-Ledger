import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { doc, updateDoc } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { collection, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { useFriendships } from '../../lib/useFriendships';
import { showGamePointsIfAny } from '../../lib/pointsApi';
import {
  parseCard,
  SUIT_SYMBOL,
  SUIT_RED,
  sortHandForDisplay,
  legalCards,
  teamForSeat,
  MIN_BID,
  MAX_BID,
  TURN_TIMEOUT_MS,
  TURN_WARNING_MS,
  TARGET_SCORE,
  BAG_PENALTY_THRESHOLD,
  BAG_PENALTY,
  type SpadePledgeTable,
  type SpadePledgeDeal,
  type SpadePledgeHandHistoryEntry,
} from '../../lib/spadePledge';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { SPADE_PLEDGE_HELP } from '../../lib/gameHelp';
import { ReactionButton, ReactionOverlay, useReactionOverlay } from '../../components/GameReactions';
import { ChatButton, ChatPanel, useGameChat } from '../../components/GameChat';
import { VoiceChatButton, useGameVoice } from '../../components/GameVoiceChat';
import InvitePicker from '../../components/InvitePicker';
import PresenceDot from '../../components/PresenceDot';
import ShareGameButton from '../../components/ShareGameButton';
import Fireworks from '../../components/Fireworks';
import DraggableCard from '../../components/DraggableCard';
import { useGameTurnPresence } from '../../lib/gameTurnPresence';

// Card face. `hand` fills whatever grid cell it's put in (the hand is a 7-column grid, so cards
// scale with the screen instead of staying a fixed tiny size); `played` is the card sitting on the
// table, sized off the viewport width (capped) so it stays proportionate on phones and tablets.
const CardChip: React.FC<{ cardId: string; dim?: boolean; highlight?: boolean; onClick?: () => void; size?: 'played' | 'hand' | 'pile' }> = ({
  cardId, dim, highlight, onClick, size = 'played',
}) => {
  const { rank, suit } = parseCard(cardId);
  const red = SUIT_RED[suit];
  const isHand = size === 'hand';
  const isPile = size === 'pile';
  // `pile` is the just-won trick stacked under a seat: cards overlap, so rank + suit sit in the
  // top-left corner (the part that stays visible) instead of the centre.
  // `hand` cards overlap in a single fanned row (see the hand block below), so — like `pile` —
  // rank + suit live in the top-left corner, the strip that stays visible under the next card.
  const dims = isHand
    ? 'w-[min(18vw,5rem)] aspect-[5/7] text-base items-start justify-start pl-1.5 pt-1'
    : isPile
      ? 'w-[min(10vw,2.4rem)] aspect-[5/7] text-xs items-start justify-start pl-1 pt-0.5'
      : 'w-[min(14vw,3.75rem)] aspect-[5/7] text-sm';
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      className={`relative ${dims} shrink-0 rounded-lg border-2 flex flex-col font-bold bg-white ${isPile || isHand ? '' : 'items-center justify-center'} transition-all ${
        onClick ? 'cursor-pointer active:scale-95' : ''
      } ${highlight ? 'border-warning ring-2 ring-warning/60 -translate-y-1 shadow-md' : 'border-border-subtle'} ${
        dim ? 'opacity-30' : ''
      } ${red ? 'text-error' : 'text-on-surface'}`}
    >
      <span className="leading-none">{rank}</span>
      <span className={`${isHand ? 'text-2xl' : isPile ? 'text-base' : 'text-xl'} leading-none`}>{SUIT_SYMBOL[suit]}</span>
    </div>
  );
};

// Green/amber/red as a group's accumulated bags climb toward the penalty threshold — bags are
// "over-achieved" tricks (made the bid, then took extra ones beyond it), and BAG_PENALTY_THRESHOLD
// of them costs BAG_PENALTY points. 0-4 is comfortably safe, 5-8 is a genuine "start being careful"
// zone, 9+ means the very next overtrick risks tipping the penalty.
function bagTier(bags: number): 'safe' | 'caution' | 'danger' {
  if (bags > 8) return 'danger';
  if (bags >= 5) return 'caution';
  return 'safe';
}
const BAG_TIER_CLASS: Record<ReturnType<typeof bagTier>, string> = {
  safe: 'text-success',
  caution: 'text-warning font-bold',
  danger: 'text-error font-bold animate-pulse',
};

// Same tiers as BAG_TIER_CLASS, but legible on the dark green felt of the table.
const BAG_TIER_FELT_CLASS: Record<ReturnType<typeof bagTier>, string> = {
  safe: 'text-emerald-200/80',
  caution: 'text-amber-300 font-bold',
  danger: 'text-red-300 font-bold animate-pulse',
};

// "Swallow the value already present on mount, only fire on a genuinely NEW change" — same pattern
// as Rummy13Game.tsx's useDealEndedToast, keyed by handNumber. Unlike that toast, this one doesn't
// auto-dismiss — the player reviews the hand's scores and taps Continue (or Exit) themselves; the
// next hand has already been dealt server-side underneath (resolveSpadePledgeHandEnd is atomic, no
// host-confirm step), so dismissing is purely a client-side "I've seen this" action.
function useHandEndedModal(summary: SpadePledgeHandHistoryEntry | null | undefined, tableStatus: string | undefined) {
  const [shown, setShown] = useState<SpadePledgeHandHistoryEntry | null>(null);
  const seenRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (seenRef.current === undefined) {
      seenRef.current = summary?.handNumber;
      return;
    }
    if (!summary || summary.handNumber === seenRef.current) return;
    seenRef.current = summary.handNumber;
    if (tableStatus !== 'active') return;
    setShown(summary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.handNumber, tableStatus]);

  return { summary: shown, dismiss: () => setShown(null) };
}

const FORMAT_LABEL: Record<string, string> = { partnership: 'Partnership', ffa: 'Free-for-all' };
const RELATIVE_POSITION_CLASS: Record<number, string> = {
  0: 'col-start-2 row-start-3', // me — bottom
  1: 'col-start-1 row-start-2', // left
  2: 'col-start-2 row-start-1', // top (partner, in partnership)
  3: 'col-start-3 row-start-2', // right
};

export default function SpadePledgeGame() {
  const { tableId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { friendCandidates } = useFriendships(user?.uid);

  const [tableSnap, tableLoading] = useDocument(tableId ? doc(db, 'spadePledgeTables', tableId) : null);
  const table = tableSnap?.exists() ? (tableSnap.data() as SpadePledgeTable) : null;
  const dealId = table?.currentDealId || null;

  const [dealSnap, dealLoading] = useDocument(dealId ? doc(db, 'spadePledgeDeals', dealId) : null);
  const deal = dealSnap?.exists() ? (dealSnap.data() as SpadePledgeDeal) : null;

  const voice = useGameVoice('spadePledgeTables', tableId, table?.players || []);

  const shownPointsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!tableId || !user || table?.status !== 'finished') return;
    if (shownPointsRef.current.has(tableId)) return;
    shownPointsRef.current.add(tableId);
    showGamePointsIfAny('spadePledge', tableId);
  }, [tableId, user, table?.status]);

  useGameTurnPresence('spadePledge', tableId);

  const floatingReactions = useReactionOverlay(table?.lastReaction);
  const { summary: handEndedSummary, dismiss: dismissHandEndedModal } = useHandEndedModal(table?.lastHandSummary, table?.status);
  const handleSendReaction = async (emoji: string) => {
    if (!user || !tableId) return;
    try {
      const idToken = await user.getIdToken();
      await fetch('/api/games/react', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameType: 'spadePledge', gameId: tableId, emoji }),
      });
    } catch (err) {
      console.error('Failed to send reaction:', err);
    }
  };

  const [handSnap] = useDocument(
    dealId && user && deal?.status === 'active' ? doc(db, 'spadePledgeDeals', dealId, 'hands', user.uid) : null,
  );
  const handCards: string[] = handSnap?.exists() ? (handSnap.data().cards || []) : [];
  const handSorted = useMemo(() => sortHandForDisplay(handCards), [handCards]);

  const [groupsMembersValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = groupsMembersValue?.docs.map((d) => d.data().groupId) || [];
  const [showInvite, setShowInvite] = useState(false);

  const { messages: chatMessages, loading: chatLoading, hasUnseen: chatUnseen, markSeen: markChatSeen } = useGameChat('spadePledgeTables', tableId);
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
  const [addingBot, setAddingBot] = useState(false);
  // Drag-to-play: the table is the drop target; draggingCard just lights it up while a card is held.
  const tableDropRef = useRef<HTMLDivElement>(null);
  const [draggingCard, setDraggingCard] = useState<string | null>(null);
  // True from the moment a card starts moving until just after release, so the click the browser
  // fires at the end of a drag is never mistaken for a tap-to-play.
  const cardWasDragged = useRef(false);

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

  const callTimeoutBestEffort = async (targetDealId: string) => {
    if (!user) return;
    try {
      const idToken = await user.getIdToken();
      await fetch('/api/spadePledge/timeout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealId: targetDealId }),
      });
    } catch {
      // Ignore — another client's call likely already resolved it, or it hadn't actually timed out.
    }
  };

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
  const isPartnership = table.format === 'partnership';

  const myDealIndex = deal?.players.findIndex((p) => p.uid === user.uid) ?? -1;
  const meInDeal = deal && myDealIndex >= 0 ? deal.players[myDealIndex] : null;
  // Gated on !me?.isBot too — once a seat is bot-controlled, the server resolves its turns itself
  // (see drainSpadePledgeBotTurns), so this client should never offer manual controls for it.
  const isMyBidTurn = deal?.status === 'active' && deal.phase === 'bidding' && !me?.isBot && deal.players[deal.currentTurnSeatIndex]?.uid === user.uid;
  const isMyPlayTurn = deal?.status === 'active' && deal.phase === 'playing' && !me?.isBot && deal.players[deal.currentTurnSeatIndex]?.uid === user.uid;
  const myLegalCards = deal && meInDeal && isMyPlayTurn ? legalCards(handSorted, deal.currentTrick, deal.spadesBroken) : [];

  const nameFor = (uid: string) => (uid === user.uid ? 'You' : table.players.find((p) => p.uid === uid)?.displayName || '…');

  const handleJoinTable = async () => {
    if (!user || isPlayer || table.players.length >= 4) return;
    setError(null);
    try {
      const newPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: table.players.length,
        team: teamForSeat(table.format, table.players.length),
        isBot: false,
        consecutiveTimeouts: 0,
      };
      await updateDoc(doc(db, 'spadePledgeTables', tableId), {
        players: [...table.players, newPlayer],
        playerUids: [...table.playerUids, user.uid],
      });
    } catch (err) {
      console.error('Failed to join Spade Pledge table:', err);
      setError('Failed to join — the table may already be full or started.');
    }
  };

  const handleFillBot = async () => {
    setAddingBot(true);
    setError(null);
    try {
      await call('/api/spadePledge/fill-bot', {});
    } catch {
      // error already surfaced via `error` state
    } finally {
      setAddingBot(false);
    }
  };

  const handleInvite = async (inviteeUids: string[], poke = false) => {
    if (!user || inviteeUids.length === 0) return;
    const idToken = await user.getIdToken();
    await fetch('/api/spadePledge/invite', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: tableId, inviteeUids, poke }),
    }).catch((err) => console.error('spadePledge invite failed:', err));
    if (!poke) setShowInvite(false);
  };

  const handleStart = async () => {
    await call('/api/spadePledge/start', {}).catch(() => {});
  };

  const handleCopyCode = () => {
    navigator.clipboard?.writeText(table.code).catch(() => {});
  };

  const handleBid = async (value: number) => {
    await call('/api/spadePledge/bid', { bid: value }).catch(() => {});
  };

  const handlePlay = async (cardId: string) => {
    await call('/api/spadePledge/play', { cardId }).catch(() => {});
  };

  const handleReclaimSeat = async () => {
    await call('/api/spadePledge/reclaim-seat', {}).catch(() => {});
  };

  const handleLeaveGame = async () => {
    if (!window.confirm('Quit this match? A bot will take over your seat and keep playing for the rest of the match — you can come back and reclaim it anytime before it finishes.')) return;
    try {
      await call('/api/spadePledge/leave', {});
      navigate('/tools?category=games');
    } catch {
      // error already surfaced via `error` state
    }
  };

  const handleDeleteTable = async () => {
    if (!window.confirm('Delete this table? This cannot be undone.')) return;
    try {
      await call('/api/spadePledge/delete', {});
      navigate('/games/spadePledge');
    } catch {
      // error already surfaced via `error` state
    }
  };

  const handlePlayAgain = async () => {
    try {
      const json = await call('/api/spadePledge/rematch', {});
      if (json?.gameId) navigate(`/games/spadePledge/${json.gameId}`);
    } catch {
      // error already surfaced via `error` state
    }
  };

  // ---- Waiting room ----
  if (table.status === 'waiting') {
    const partnerSeatIndex = me ? (me.seatIndex + 2) % 4 : null;
    const partner = isPartnership && partnerSeatIndex !== null ? table.players.find((p) => p.seatIndex === partnerSeatIndex) : null;

    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <ReactionOverlay reactions={floatingReactions} />
        <header className="p-4 flex items-center gap-3 bg-white border-b border-border-subtle">
          <h1 className="font-black text-primary">Spade Pledge</h1>
          <ReactionButton onSend={handleSendReaction} />
          <div className="flex items-center gap-1 ml-auto">
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
          {showHelp && <GameHelpModal content={SPADE_PLEDGE_HELP} onClose={() => setShowHelp(false)} />}
        </header>
        {showChat && user && (
          <ChatPanel
            collectionName="spadePledgeTables"
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
                Share code · {FORMAT_LABEL[table.format]}
              </p>
              <p className="text-2xl font-black text-primary tracking-widest">{table.code}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={handleCopyCode} className="px-3 py-2 bg-primary/10 text-primary rounded-xl text-xs font-bold flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">content_copy</span> Copy
              </button>
              <ShareGameButton
                gameLabel="Spade Pledge"
                code={table.code}
                path={`/games/spadePledge/${tableId}`}
                className="px-3 py-2 bg-[#25D366] text-white rounded-xl text-xs font-bold flex items-center gap-1"
              />
            </div>
          </div>

          {isPartnership && (
            <p className="text-xs text-text-muted italic px-1 text-center">
              {partner ? `You + ${partner.displayName} are partners.` : 'Partners sit opposite each other — waiting for more seats to fill.'}
            </p>
          )}

          <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
            {table.players.map((p) => (
              <div key={p.uid} className="p-4 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold overflow-hidden">
                  {p.isBot ? '🤖' : p.photoURL ? (
                    <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    p.displayName?.slice(0, 1) || '?'
                  )}
                </div>
                <p className="text-sm font-bold text-on-surface">{p.displayName}</p>
                {p.uid === table.hostUid && <span className="ml-auto text-[10px] font-bold text-primary uppercase">Host</span>}
              </div>
            ))}
            {Array.from({ length: Math.max(0, 4 - table.players.length) }).map((_, i) => (
              <div key={i} className="p-4 flex items-center gap-3 opacity-40">
                <div className="w-9 h-9 rounded-full border-2 border-dashed border-border-subtle" />
                <p className="text-sm text-text-muted italic">Waiting for player…</p>
              </div>
            ))}
          </div>

          {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

          {!isPlayer && table.players.length < 4 && (
            <button onClick={handleJoinTable} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">
              Join Table
            </button>
          )}

          {isPlayer && table.players.length < 4 && (
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

          {isPlayer && user.uid === table.hostUid && table.players.length < 4 && (
            <button
              onClick={handleFillBot}
              disabled={addingBot}
              className="w-full py-2.5 border border-border-subtle text-primary font-bold rounded-xl text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">smart_toy</span>
              {addingBot ? 'Adding…' : 'Fill Empty Seat with Bot'}
            </button>
          )}

          {isPlayer && user.uid === table.hostUid ? (
            <button
              onClick={handleStart}
              disabled={busy || table.players.length !== 4}
              className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
            >
              {table.players.length !== 4 ? 'Need exactly 4 players' : busy ? 'Starting…' : 'Start Table'}
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
    const winnerGroup = table.groups.find((g) => g.groupIndex === table.winnerTeam);
    const winnerNames = winnerGroup ? winnerGroup.memberUids.map((uid) => nameFor(uid)).join(' & ') : null;
    const standings = [...table.groups].sort((a, b) => b.cumulativeScore - a.cumulativeScore);

    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <ReactionOverlay reactions={floatingReactions} />
        <div className="relative shrink-0 bg-primary/5 border-b border-border-subtle px-4 py-4 text-center overflow-hidden">
          <Fireworks />
          <span className="relative text-4xl">🏆</span>
          <div className="relative flex items-center justify-center gap-2 mt-1">
            <h1 className="text-lg font-black text-primary">{winnerNames ? `${winnerNames} win${isPartnership ? '' : 's'}!` : 'Match over'}</h1>
            <ReactionButton onSend={handleSendReaction} />
          </div>
          {error && <p className="relative text-xs font-bold text-error mt-1">{error}</p>}
          <div className="relative flex items-center gap-2 mt-3">
            {isPlayer && (
              <button
                onClick={() => (table.rematchGameId ? navigate(`/games/spadePledge/${table.rematchGameId}`) : handlePlayAgain())}
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
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-1.5">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Final Standings</p>
            {standings.map((g) => (
              <div key={g.groupIndex} className="flex items-center gap-2 px-1 py-1">
                <span className={`text-sm font-bold flex-1 ${g.groupIndex === table.winnerTeam ? 'text-success' : 'text-on-surface'}`}>
                  {g.memberUids.map((uid) => nameFor(uid)).join(' & ')}
                </span>
                <span className="text-xs font-bold text-text-muted">{g.cumulativeScore} pts</span>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-2">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Hand-by-Hand</p>
            {(table.dealHistory || []).slice().reverse().map((h, idx) => (
              <div key={idx} className="text-[11px] border-t border-border-subtle first:border-t-0 pt-1.5 first:pt-0 space-y-0.5">
                <p className="font-bold text-text-muted">Hand {h.handNumber}</p>
                {Object.entries(h.bids).map(([uid, bid]) => (
                  <p key={uid} className="text-text-muted">
                    {nameFor(uid)}: bid {bid}{bid === 0 ? ' (Nil)' : ''}, won {h.tricksWon[uid]}
                    {h.nilResults[uid] ? ` — Nil ${h.nilResults[uid]}` : ''}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </main>
      </div>
    );
  }

  // ---- Active ----
  if (!deal) return <div className="p-8 text-center text-text-muted">Loading hand…</div>;

  const currentTurnUid = deal.players[deal.currentTurnSeatIndex]?.uid;
  const currentTurnIsMyBot = me?.isBot && currentTurnUid === user.uid;
  const currentTurnLabel = currentTurnIsMyBot ? 'Your bot' : nameFor(currentTurnUid);
  const turnStatusText = deal.phase === 'bidding'
    ? isMyBidTurn ? 'Your turn — place your bid' : `${currentTurnLabel}'s turn to bid`
    : isMyPlayTurn ? 'Your turn — play a card' : `${currentTurnLabel}'s turn`;
  const timerWarning = remainingSec !== null && remainingSec <= TURN_WARNING_MS / 1000;

  const relSeatOf = (seatIndex: number) => (me ? (seatIndex - me.seatIndex + 4) % 4 : seatIndex);
  const trickPlayBySeat = new Map<number, string>();
  for (const play of deal.currentTrick.cards) trickPlayBySeat.set(play.seatIndex, play.cardId);
  // The most recently completed trick — kept visible (face-up) to everyone at the winner's seat
  // until the next trick resolves. Cards share a layoutId with their in-progress render above, so
  // Framer Motion animates them sliding from wherever they were played into the winner's pile.
  const lastTrick = deal.completedTricks.length > 0 ? deal.completedTricks[deal.completedTricks.length - 1] : null;

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <ReactionOverlay reactions={floatingReactions} />

      <AnimatePresence>
        {handEndedSummary && (
          <motion.div
            key="hand-summary-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[280] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', damping: 20, stiffness: 300 }}
              className="relative w-full max-w-xs bg-white rounded-3xl shadow-2xl p-5 space-y-4 text-center max-h-[85vh] overflow-y-auto"
            >
              <div>
                <span className="material-symbols-outlined text-4xl text-primary">scoreboard</span>
                <h2 className="text-lg font-black text-primary mt-1">Hand {handEndedSummary.handNumber} Complete</h2>
              </div>

              <div className="space-y-2">
                {table.groups.map((g) => {
                  const delta = handEndedSummary.groupScoreDelta[g.groupIndex] ?? 0;
                  return (
                    <div key={g.groupIndex} className="bg-surface rounded-xl p-2.5 text-left">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-on-surface">{g.memberUids.map((uid) => nameFor(uid)).join(' & ')}</span>
                        <span className={`text-xs font-black shrink-0 ${delta >= 0 ? 'text-success' : 'text-error'}`}>{delta >= 0 ? '+' : ''}{delta}</span>
                      </div>
                      <p className="text-[10px] text-text-muted mt-0.5">
                        {g.memberUids.map((uid) => `${nameFor(uid)} bid ${handEndedSummary.bids[uid]}, won ${handEndedSummary.tricksWon[uid]}`).join(' · ')}
                      </p>
                      <div className="flex items-center justify-between mt-1 pt-1 border-t border-border-subtle">
                        <span className="text-[9px] font-bold text-text-muted uppercase">Total</span>
                        <span className="text-[11px] font-black">
                          <span className="text-primary">{handEndedSummary.netScoreAfter[g.groupIndex]} pts</span>
                          {' · '}
                          <span className={BAG_TIER_CLASS[bagTier(handEndedSummary.groupBagsAfter[g.groupIndex])]}>
                            {handEndedSummary.groupBagsAfter[g.groupIndex]} bags
                          </span>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => navigate('/tools?category=games')}
                  className="flex-1 py-2.5 border border-border-subtle text-text-muted font-bold rounded-xl text-sm"
                >
                  Exit
                </button>
                <button
                  onClick={dismissHandEndedModal}
                  className="flex-1 py-2.5 bg-primary text-white font-bold rounded-xl text-sm"
                >
                  Continue
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {showHelp && <GameHelpModal content={SPADE_PLEDGE_HELP} onClose={() => setShowHelp(false)} />}
      {showChat && user && (
        <ChatPanel
          collectionName="spadePledgeTables"
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
              <h1 className="font-black text-primary text-xs">Spade Pledge</h1>
              <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{table.code} · {FORMAT_LABEL[table.format]}</span>
            </div>
            <ReactionButton onSend={handleSendReaction} />
            <div className="flex items-center gap-1.5 ml-auto">
              <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
              <VoiceChatButton voice={voice} />
              <HelpButton onClick={() => setShowHelp(true)} />
              <button
                onClick={handleLeaveGame}
                aria-label="Quit Match"
                className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-surface"
              >
                <span className="material-symbols-outlined text-[18px]">logout</span>
              </button>
            </div>
          </header>

          <div className="p-2 max-w-xl mx-auto w-full space-y-2">
            {table.groups.some((g) => g.bags >= 5) && (
              <p className="text-[10px] font-bold text-warning px-1 flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px]">warning</span>
                {BAG_PENALTY_THRESHOLD} bags triggers a -{BAG_PENALTY} point penalty — {table.groups.some((g) => g.bags > 8) ? 'the next overtrick could tip it' : 'watch your overtricks'}.
              </p>
            )}

            <div className="bg-white rounded-xl border border-border-subtle p-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <p className={`text-[11px] font-bold ${(isMyBidTurn || isMyPlayTurn) ? 'text-primary' : 'text-text-muted'}`}>{turnStatusText}</p>
                <div className="flex items-center gap-2">
                  {deal.spadesBroken && <span className="text-[9px] font-bold text-text-muted uppercase">♠ broken</span>}
                  {remainingSec !== null && (
                    <span className={`text-[11px] font-black px-1.5 py-0.5 rounded-full ${timerWarning ? 'bg-error/10 text-error animate-pulse' : 'text-text-muted'}`}>
                      {remainingSec}s
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-2 max-w-xl mx-auto w-full pb-4 min-h-full flex flex-col gap-3">
            {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

            {me?.isBot && (
              <div className="bg-warning/10 border border-warning/30 rounded-xl p-3 flex items-center justify-between gap-2">
                <p className="text-[11px] font-bold text-warning">
                  A bot is playing your seat — you missed 2 turns in a row.
                </p>
                <button
                  onClick={handleReclaimSeat}
                  disabled={busy}
                  className="px-3 py-1.5 bg-warning text-white rounded-lg text-[11px] font-bold shrink-0 disabled:opacity-50"
                >
                  I'm back — take control
                </button>
              </div>
            )}

            {/* Table — a felt card table: wooden rim, green baize with a soft spotlight, each seat a
                compact avatar + name/score plate next to the card it played. The grid stretches to
                fill the screen height so the table (and its cards) use the room available. */}
            <div
              ref={tableDropRef}
              className={`relative flex-1 min-h-[250px] grid grid-cols-3 grid-rows-3 gap-1 rounded-[1.75rem] border-[5px] p-2 place-items-center transition-all overflow-hidden shadow-[inset_0_0_36px_rgba(0,0,0,0.5),0_6px_16px_rgba(0,0,0,0.25)] bg-[radial-gradient(ellipse_at_center,#1f7a5a_0%,#165c44_55%,#0e3f2f_100%)] ${
                draggingCard ? 'border-amber-300 ring-4 ring-amber-300/40' : 'border-[#4a3322]'
              }`}
            >
              <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-[9rem] leading-none text-white/[0.05] select-none">♠</span>
              <div className="relative col-start-2 row-start-2 flex flex-col items-center text-center leading-tight">
                <span className="text-[10px] font-bold text-emerald-100/70 uppercase tracking-[0.2em]">Hand {deal.handNumber}</span>
                {deal.spadesBroken && <span className="text-[10px] font-bold text-emerald-100/70">♠ broken</span>}
              </div>
              {deal.players.map((p) => {
                const played = trickPlayBySeat.get(p.seatIndex);
                const isLastTrickWinner = lastTrick && lastTrick.winnerSeatIndex === p.seatIndex;
                const rel = relSeatOf(p.seatIndex);
                const tp = table.players.find((x) => x.uid === p.uid);
                const isTurn = p.seatIndex === deal.currentTurnSeatIndex;
                const grp = table.groups.find((g) => g.memberUids.includes(p.uid));
                const info = deal.phase === 'bidding' ? (p.bid !== null ? `bid ${p.bid}` : '…') : `${p.tricksWon}/${p.bid ?? '?'}`;
                return (
                  <div key={p.uid} className={`relative flex flex-col items-center gap-0.5 ${RELATIVE_POSITION_CLASS[rel]}`}>
                    <div className={`flex items-center gap-1.5 ${rel === 3 ? 'flex-row-reverse' : ''}`}>
                      <div className={`flex flex-col items-center w-[min(15vw,3.75rem)] rounded-xl px-1 py-1 backdrop-blur-sm transition-colors ${isTurn ? 'bg-amber-300/15 ring-1 ring-amber-300/60' : 'bg-black/20'}`}>
                        <div className={`relative w-[min(8.5vw,2rem)] aspect-square rounded-full bg-emerald-950 flex items-center justify-center text-white text-xs font-bold ${isTurn ? 'ring-2 ring-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.85)]' : 'ring-1 ring-white/30'}`}>
                          <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center">
                            {tp?.isBot ? '🤖' : tp?.photoURL ? (
                              <img src={tp.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              nameFor(p.uid).slice(0, 1)
                            )}
                          </div>
                          <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2 h-2" />
                        </div>
                        <span className={`mt-0.5 text-[10px] font-semibold max-w-full truncate ${isTurn ? 'text-amber-200' : 'text-white'}`}>{p.seatIndex === me?.seatIndex ? 'You' : nameFor(p.uid)}</span>
                        {grp && (
                          <span className="text-[10px] font-black text-amber-300 whitespace-nowrap leading-tight">
                            {grp.cumulativeScore}<span className="text-white/50 font-bold">/{TARGET_SCORE}</span>
                          </span>
                        )}
                        <span className="text-[9px] whitespace-nowrap leading-tight text-emerald-100/80">
                          {grp && <span className={BAG_TIER_FELT_CLASS[bagTier(grp.bags)]}>{grp.bags} bags</span>}
                          {grp && ' · '}{info}
                        </span>
                      </div>
                      {played ? (
                        <motion.div layoutId={`sp-card-${dealId}-${played}`} className="drop-shadow-[0_3px_5px_rgba(0,0,0,0.45)]">
                          <CardChip cardId={played} size="played" />
                        </motion.div>
                      ) : (
                        <div className="w-[min(14vw,3.75rem)] aspect-[5/7] rounded-lg border-2 border-dashed border-white/25 bg-black/10" />
                      )}
                    </div>
                    {/* Tricks-won pile — the trick this seat most recently won shows its real cards
                        (visible to everyone, sliding in from wherever each card was played); older
                        tricks just contribute to the plain count. */}
                    {p.tricksWon > 0 && isLastTrickWinner && (
                      <div className="flex -space-x-3 drop-shadow-[0_2px_3px_rgba(0,0,0,0.4)]">
                        {lastTrick!.cards.map((play) => (
                          <motion.div key={play.cardId} layoutId={`sp-card-${dealId}-${play.cardId}`}>
                            <CardChip cardId={play.cardId} size="pile" />
                          </motion.div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Bidding sheet */}
            {isMyBidTurn && (
              <div className="bg-white rounded-2xl border border-border-subtle p-3 space-y-2">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">How many tricks will you win?</p>
                <div className="grid grid-cols-7 gap-1.5">
                  {Array.from({ length: MAX_BID - MIN_BID + 1 }).map((_, i) => {
                    const n = MIN_BID + i;
                    return (
                      <button
                        key={n}
                        onClick={() => handleBid(n)}
                        disabled={busy}
                        className="py-3 rounded-lg text-sm font-black bg-primary/10 text-primary disabled:opacity-40 active:scale-95"
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Your hand */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-bold text-text-muted uppercase px-1">
                Your Hand ({handSorted.length}){isMyPlayTurn ? ' — tap a card to play it' : ''}
              </p>
              {/* One row, whatever the card count: every card but the last shares the row's leftover
                  width (so they overlap as needed), the last one is shown in full; with few cards left
                  the wrappers cap at one card width so they simply sit side by side. */}
              <div className="flex justify-center px-1 pt-2">
                {handSorted.map((c, idx) => {
                  const isLegal = isMyPlayTurn && myLegalCards.includes(c);
                  const isLast = idx === handSorted.length - 1;
                  return (
                    <div key={c} className={isLast ? 'shrink-0' : 'flex-1 min-w-0 max-w-[min(18vw,5rem)]'}>
                      {/* A playable card can be tapped OR dragged onto the table. Once dragged at all, it
                          only plays if the card itself is on the table: at least a quarter of its
                          height over the table, its middle within the table's width. Otherwise it
                          snaps back. The held card is drawn above the table (see DraggableCard). */}
                      <DraggableCard
                        enabled={isLegal && !busy}
                        onTap={isLegal && !busy ? () => handlePlay(c) : undefined}
                        draggedFlag={cardWasDragged}
                        onDragState={(d) => setDraggingCard(d ? c : null)}
                        onDrop={(cardRect) => {
                          const tableRect = tableDropRef.current?.getBoundingClientRect();
                          if (!tableRect) return;
                          const overlapY = Math.min(cardRect.bottom, tableRect.bottom) - Math.max(cardRect.top, tableRect.top);
                          const centerX = (cardRect.left + cardRect.right) / 2;
                          if (overlapY >= cardRect.height * 0.25 && centerX >= tableRect.left && centerX <= tableRect.right) handlePlay(c);
                        }}
                      >
                        <CardChip
                          cardId={c}
                          size="hand"
                          dim={isMyPlayTurn && !isLegal}
                          highlight={isLegal}
                        />
                      </DraggableCard>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
