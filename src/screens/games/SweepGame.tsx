import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
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
  captureValue,
  cardPoints,
  sumCardValues,
  sumPoints,
  sortHandForDisplay,
  canCaptureValue,
  type SweepGame as SweepGameDoc,
  type SweepFloor,
  type SweepHouse,
} from '../../lib/sweep';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { SWEEP_HELP } from '../../lib/gameHelp';
import { ReactionButton, ReactionOverlay, useReactionOverlay } from '../../components/GameReactions';
import { ChatButton, ChatPanel, useGameChat } from '../../components/GameChat';
import InvitePicker from '../../components/InvitePicker';
import PresenceDot from '../../components/PresenceDot';
import ShareGameButton from '../../components/ShareGameButton';
import { useGameTurnPresence } from '../../lib/gameTurnPresence';
import Fireworks from '../../components/Fireworks';

const TEAM_COLOR = ['#2563EB', '#DC2626'];

const SWEEP_MESSAGES = [
  "SWEEP! Not a crumb left behind.",
  "CLEAN SWEEP! The floor is shook.",
  "Sweep! Someone call a cleaning crew.",
  "SWEEEEP! That's a broom to the face.",
  "Floor: 0. You: everything.",
  "Table wiped. Absolutely spotless.",
  "That's not a capture, that's a eviction notice.",
  "SWEEP! The floor has left the chat.",
];
const TEAM_LABEL = ['Team A', 'Team B'];

const CardChip: React.FC<{
  cardId: string;
  selected?: boolean;
  dim?: boolean;
  faceDown?: boolean;
  onClick?: () => void;
  // Default (unset) is a HAND card, sized 25% smaller than this game's original single hand-card
  // size. 'played' is any card that's left the hand and is now on the table (floor, house,
  // captured pile, deal history) — was 50% smaller than that original size, then bumped 50%
  // bigger again after that read too small in practice, landing at 27x36 (~44% of the original).
  size?: 'played';
}> = ({ cardId, selected, dim, faceDown, onClick, size }) => {
  const dims = size === 'played' ? 'w-[27px] h-9 text-[9px]' : 'w-9 h-12 text-[11px]';
  if (faceDown) {
    return (
      <div className={`${dims} shrink-0 rounded-lg border-2 border-border-subtle bg-primary flex items-center justify-center`}>
        <span className="material-symbols-outlined rotate-180 text-white text-[18px]">style</span>
      </div>
    );
  }
  const { rank, suit } = parseCard(cardId);
  const red = SUIT_RED[suit];
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      className={`relative ${dims} shrink-0 rounded-lg border-2 flex flex-col items-center justify-center font-bold bg-white transition-all ${
        onClick ? 'cursor-pointer' : ''
      } ${selected ? 'border-primary -translate-y-2 shadow-md' : 'border-border-subtle'} ${dim ? 'opacity-40' : ''} ${
        red ? 'text-error' : 'text-on-surface'
      }`}
    >
      <span>{rank}</span>
      <span className="text-base leading-none">{SUIT_SYMBOL[suit]}</span>
    </div>
  );
};

const HouseTile: React.FC<{
  house: SweepHouse;
  players: SweepGameDoc['players'];
  selected?: boolean;
  onClick?: () => void;
}> = ({ house, players, selected, onClick }) => {
  const ownerTeams = house.ownerTeams;
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      className={`rounded-xl border-2 p-1.5 space-y-1 shrink-0 ${onClick ? 'cursor-pointer' : ''} ${
        selected ? 'border-primary ring-2 ring-primary/40' : 'border-border-subtle'
      } bg-surface`}
    >
      <div className="flex items-center gap-1 px-0.5">
        <span className="text-[10px] font-black text-primary">House · {house.value}</span>
        {house.sets.length > 1 && <span className="text-[9px] font-bold text-warning uppercase">Strong</span>}
        <div className="flex gap-0.5 ml-auto">
          {ownerTeams.map((t) => (
            <span key={t} className="w-2 h-2 rounded-full" style={{ background: TEAM_COLOR[t] }} />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        {house.sets.map((s, i) => (
          <div key={i} className="flex gap-0.5">
            {s.cards.map((c) => (
              <CardChip key={c} cardId={c} size="played" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

type ActionMode = 'capture' | 'house' | 'throw';

export default function SweepGame() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { friendCandidates } = useFriendships(user?.uid);

  const [gameSnap, loading] = useDocument(gameId ? doc(db, 'sweepGames', gameId) : null);
  const game = gameSnap?.exists() ? (gameSnap.data() as SweepGameDoc) : null;

  // Points are awarded inline, server-side, the moment the MATCH (not just a deal) finish
  // transaction commits — this just triggers every player's OWN flying-coins animation once their
  // client notices it (deduped per gameId so a re-render never re-triggers it).
  const shownSweepPointsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!gameId || !user || game?.status !== 'finished') return;
    if (shownSweepPointsRef.current.has(gameId)) return;
    shownSweepPointsRef.current.add(gameId);
    showGamePointsIfAny('sweep', gameId);
  }, [gameId, user, game?.status]);

  // "It's your turn" presence — see notifyGameTurn in server.ts, called from
  // /api/sweep/resolve-bid and /api/sweep/play.
  useGameTurnPresence('sweep', gameId);

  const floatingReactions = useReactionOverlay(game?.lastReaction);
  const handleSendQuickReaction = async (emoji: string) => {
    if (!user || !gameId) return;
    try {
      const idToken = await user.getIdToken();
      await fetch('/api/games/react', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameType: 'sweep', gameId, emoji }),
      });
    } catch (err) {
      console.error('Failed to send reaction:', err);
    }
  };

  const [handSnap] = useDocument(
    gameId && user && (game?.status === 'active' || game?.status === 'bidding') ? doc(db, 'sweepGames', gameId, 'hands', user.uid) : null,
  );
  const handData = handSnap?.exists() ? handSnap.data() : null;
  const handCards: string[] = handData?.cards || [];
  const handSorted = useMemo(() => sortHandForDisplay(handCards), [handCards]);

  const [groupsMembersValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = groupsMembersValue?.docs.map((d) => d.data().groupId) || [];
  const [showInvite, setShowInvite] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const { messages: chatMessages, loading: chatLoading, hasUnseen: chatUnseen, markSeen: markChatSeen } = useGameChat('sweepGames', gameId);
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

  // Bidding — local scratch state, only meaningful while game.status === 'bidding' and I'm the
  // bidder. bidValue is chosen first; the action + selections follow it. 'capture' still uses the
  // single bidFloorCards list. 'house' can build MULTIPLE sets in one turn (see server comment on
  // /api/sweep/resolve-bid) — bidSets holds the sets already added, bidCurCardId/bidCurFloorCards
  // hold the one currently being composed (a different hand card than the bid card itself, since
  // that one's own value already equals the bid, plus optional floor cards) before it's pushed
  // into bidSets via "Add Set".
  const [bidValue, setBidValue] = useState<number | null>(null);
  const [bidAction, setBidAction] = useState<ActionMode | null>(null);
  const [bidFloorCards, setBidFloorCards] = useState<string[]>([]);
  const [bidSets, setBidSets] = useState<Array<{ cardId: string | null; floorCardIds: string[] }>>([]);
  const [bidCurCardId, setBidCurCardId] = useState<string | null>(null);
  const [bidCurFloorCards, setBidCurFloorCards] = useState<string[]>([]);

  // Regular play — select a card, then (if it doesn't directly match anything) pick an action.
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<ActionMode | null>(null);
  const [selectedFloorCards, setSelectedFloorCards] = useState<string[]>([]);
  const [selectedHouseId, setSelectedHouseId] = useState<string | null>(null);
  // Separate from `selectedHouseId` (singular, used by the "house" action to target which house
  // to extend/join) — this is a multi-select used only in capture mode, for weak houses folded
  // into a combined-value capture alongside loose cards (e.g. House·10 + a loose 3, captured by a
  // King). Sent to the server as `houseIds`.
  const [selectedCaptureHouseIds, setSelectedCaptureHouseIds] = useState<string[]>([]);

  // Deal History — collapsed by default, per-deal, purely local display state.
  const [expandedDeals, setExpandedDeals] = useState<Set<number>>(new Set());
  const toggleDealExpanded = (dealNumber: number) =>
    setExpandedDeals((s) => {
      const next = new Set(s);
      if (next.has(dealNumber)) next.delete(dealNumber);
      else next.add(dealNumber);
      return next;
    });

  useEffect(() => {
    setSelectedCard(null);
    setActionMode(null);
    setSelectedFloorCards([]);
    setSelectedHouseId(null);
    setSelectedCaptureHouseIds([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.currentTurnSeatIndex, gameId]);

  // Sweep celebration — shown to every player the instant `sweepsThisDeal` grows (server appends
  // one entry per sweep, whether it happened during bid resolution or a regular turn), not just
  // whoever did it. Tracked by array length via a ref rather than a Firestore listener of its own,
  // since this is purely a local, transient, non-authoritative animation.
  const [sweepCelebration, setSweepCelebration] = useState<{ team: 0 | 1; msg: string } | null>(null);
  const lastSweepCountRef = useRef(0);
  useEffect(() => {
    const list = game?.sweepsThisDeal || [];
    if (list.length > lastSweepCountRef.current) {
      const last = list[list.length - 1];
      setSweepCelebration({ team: last.team, msg: SWEEP_MESSAGES[Math.floor(Math.random() * SWEEP_MESSAGES.length)] });
      const t = setTimeout(() => setSweepCelebration(null), 2600);
      lastSweepCountRef.current = list.length;
      return () => clearTimeout(t);
    }
    lastSweepCountRef.current = list.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.sweepsThisDeal, gameId]);

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
  const isMyTurn = (game.status === 'active' || game.status === 'bidding') && game.players[game.currentTurnSeatIndex]?.uid === user.uid;
  const isBidder = game.status === 'bidding' && game.bidderSeatIndex != null && game.players[game.bidderSeatIndex]?.uid === user.uid;
  const isHost = user.uid === game.hostUid;
  const teamsBalanced = game.players.filter((p) => p.team === 0).length === game.players.filter((p) => p.team === 1).length;

  const handleJoinGame = async () => {
    if (!user || isPlayer || game.players.length >= game.playerCount) return;
    setError(null);
    try {
      const seatIndex = game.players.length;
      const newPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex,
        team: seatIndex % 2,
        handCount: 0,
      };
      await updateDoc(doc(db, 'sweepGames', gameId!), {
        players: [...game.players, newPlayer],
        playerUids: [...game.playerUids, user.uid],
      });
    } catch (err) {
      console.error('Failed to join Sweep game:', err);
      setError('Failed to join — the game may already be full or started.');
    }
  };

  const handleInvite = async (inviteeUids: string[], poke = false) => {
    if (!user || inviteeUids.length === 0) return;
    const idToken = await user.getIdToken();
    await fetch('/api/sweep/invite', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, inviteeUids, poke }),
    }).catch((err) => console.error('sweep invite failed:', err));
    if (!poke) setShowInvite(false);
  };

  const handleStart = async () => {
    await call('/api/sweep/start', {}).catch(() => {});
  };

  const handleSetTeam = async (uid: string, team: 0 | 1) => {
    await call('/api/sweep/set-team', { uid, team }).catch(() => {});
  };

  const handleCopyCode = () => {
    navigator.clipboard?.writeText(game.code).catch(() => {});
  };

  // Step 1 — commit to a bid value, chosen blind from the hand alone. The floor isn't visible yet
  // (to anyone, including the bidder) and reveals to everyone the instant this succeeds.
  const handleSubmitBidValue = async (value: number) => {
    await call('/api/sweep/bid', { bidValue: value }).catch(() => {});
  };

  // Step 2 — now that the floor is public, decide how to own the bid.
  const handleResolveBid = async () => {
    if (!bidAction) return;
    await call('/api/sweep/resolve-bid', { action: bidAction, floorCardIds: bidFloorCards, sets: bidSets }).catch(() => {});
    setBidAction(null);
    setBidFloorCards([]);
    setBidSets([]);
    setBidCurCardId(null);
    setBidCurFloorCards([]);
  };

  // Pushes the in-progress hand-card + floor-card selection into bidSets as one completed set,
  // then clears the in-progress selection so another set can be composed on top of it.
  const handleAddBidSet = () => {
    setBidSets((s) => [...s, { cardId: bidCurCardId, floorCardIds: bidCurFloorCards }]);
    setBidCurCardId(null);
    setBidCurFloorCards([]);
  };

  const handleRemoveBidSet = (index: number) => {
    setBidSets((s) => s.filter((_, i) => i !== index));
  };

  const handlePlay = async (action: ActionMode) => {
    if (!selectedCard) return;
    await call('/api/sweep/play', {
      cardId: selectedCard,
      action,
      extraLooseCardIds: selectedFloorCards,
      floorCardIds: selectedFloorCards,
      targetHouseId: selectedHouseId,
      houseIds: action === 'capture' ? selectedCaptureHouseIds : [],
    }).catch(() => {});
    setSelectedCard(null);
    setActionMode(null);
    setSelectedFloorCards([]);
    setSelectedHouseId(null);
    setSelectedCaptureHouseIds([]);
  };

  const handleDealNext = async () => {
    await call('/api/sweep/deal', {}).catch(() => {});
  };

  // Any player can end a mid-match game early (matches Ludo's "End Game") — this just marks it
  // finished with no winner declared; deleting the doc itself still requires the normal
  // waiting/finished-only rule, so this is the escape hatch for a stuck or abandoned game.
  const handleEndGame = async () => {
    if (!window.confirm("End this game now for everyone? This can't be undone.")) return;
    await call('/api/sweep/end', {}).catch(() => {});
  };

  const handleDeleteGame = async () => {
    if (!window.confirm('Delete this game? This cannot be undone.')) return;
    try {
      await call('/api/sweep/delete', {});
      navigate('/games/sweep');
    } catch {
      // error already surfaced via `error` state
    }
  };

  const handlePlayAgain = async () => {
    try {
      const json = await call('/api/sweep/rematch', {});
      if (json?.gameId) navigate(`/games/sweep/${json.gameId}`);
    } catch {
      // error already surfaced via `error` state
    }
  };

  const toggleFloorCard = (setter: React.Dispatch<React.SetStateAction<string[]>>, c: string) =>
    setter((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));

  // ---- Waiting room ----
  if (game.status === 'waiting') {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <ReactionOverlay reactions={floatingReactions} />
        <header className="p-4 flex items-center gap-3 bg-white border-b border-border-subtle">
          <button onClick={() => navigate('/games/sweep')} className="text-text-muted">
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          </button>
          <h1 className="font-black text-primary">Sweep</h1>
          <ReactionButton onSend={handleSendQuickReaction} />
          <div className="flex items-center gap-1.5 ml-auto">
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
        </header>
        {showHelp && <GameHelpModal content={SWEEP_HELP} onClose={() => setShowHelp(false)} />}
        {showChat && user && (
          <ChatPanel
            collectionName="sweepGames"
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
                gameLabel="Sweep"
                code={game.code}
                path={`/games/sweep/${gameId}`}
                className="px-3 py-2 bg-[#25D366] text-white rounded-xl text-xs font-bold flex items-center gap-1"
              />
            </div>
          </div>

          {game.playerCount === 4 ? (
            <div className="space-y-2">
              <p className="text-xs text-text-muted px-1">
                Partners play opposite each other. {isHost ? 'Tap a player to move them to the other team.' : 'The host can rearrange teams before starting.'}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {([0, 1] as const).map((t) => (
                  <div key={t} className="bg-white rounded-2xl border border-border-subtle overflow-hidden">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-center py-1.5" style={{ color: TEAM_COLOR[t], background: `${TEAM_COLOR[t]}14` }}>
                      {TEAM_LABEL[t]}
                    </p>
                    <div className="divide-y divide-border-subtle min-h-[92px]">
                      {game.players.filter((p) => p.team === t).map((p) => (
                        <button
                          key={p.uid}
                          onClick={isHost ? () => handleSetTeam(p.uid, t === 0 ? 1 : 0) : undefined}
                          disabled={!isHost || busy}
                          className="w-full p-3 flex items-center gap-2 text-left disabled:opacity-100"
                        >
                          <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0" style={{ background: TEAM_COLOR[t] }}>
                            {p.displayName?.slice(0, 1) || '?'}
                          </div>
                          <span className="text-xs font-bold text-on-surface truncate">{p.displayName}</span>
                          {p.uid === game.hostUid && <span className="ml-auto text-[9px] font-bold text-primary uppercase shrink-0">Host</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {Array.from({ length: Math.max(0, game.playerCount - game.players.length) }).map((_, i) => (
                <div key={i} className="bg-white rounded-2xl border border-dashed border-border-subtle p-3 flex items-center gap-3 opacity-50">
                  <div className="w-7 h-7 rounded-full border-2 border-dashed border-border-subtle" />
                  <p className="text-sm text-text-muted italic">Waiting for player…</p>
                </div>
              ))}
              {!teamsBalanced && game.players.length === game.playerCount && (
                <p className="text-xs font-bold text-warning px-1">Teams must be split 2-2 before starting.</p>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
              {game.players.map((p) => (
                <div key={p.uid} className="p-4 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold" style={{ background: TEAM_COLOR[p.team] }}>
                    {p.displayName?.slice(0, 1) || '?'}
                  </div>
                  <p className="text-sm font-bold text-on-surface">{p.displayName}</p>
                  {p.uid === game.hostUid && <span className="ml-auto text-[10px] font-bold text-primary uppercase">Host</span>}
                </div>
              ))}
              {Array.from({ length: Math.max(0, game.playerCount - game.players.length) }).map((_, i) => (
                <div key={i} className="p-4 flex items-center gap-3 opacity-40">
                  <div className="w-9 h-9 rounded-full border-2 border-dashed border-border-subtle" />
                  <p className="text-sm text-text-muted italic">Waiting for player…</p>
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-text-muted px-1">Sweep bonus: {game.sweepPoints} points. Game plays to a net score of 100.</p>

          {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

          {!isPlayer && game.players.length < game.playerCount && (
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

          {showInvite && <InvitePicker groupIds={groupIds} alreadyIn={game.players.map((p) => p.uid)} onInvite={handleInvite} extraCandidates={friendCandidates} />}

          {isPlayer && user.uid === game.hostUid ? (
            <button
              onClick={handleStart}
              disabled={busy || game.players.length < game.playerCount || (game.playerCount === 4 && !teamsBalanced)}
              className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
            >
              {game.players.length < game.playerCount
                ? `Need ${game.playerCount} players`
                : game.playerCount === 4 && !teamsBalanced
                ? 'Teams must be 2-2'
                : busy
                ? 'Starting…'
                : 'Start Game'}
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

  // ---- Finished (net score reached +-100) ----
  if (game.status === 'finished') {
    const winnerText = game.winnerTeam != null ? `${TEAM_LABEL[game.winnerTeam]} wins the match!` : 'Match over';
    const capturedByTeam = game.capturedByTeam || { team0: [], team1: [] };
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <div className="relative shrink-0 bg-primary/5 border-b border-border-subtle px-4 py-4 text-center overflow-hidden">
          <Fireworks />
          <span className="relative text-4xl">🏆</span>
          <h1 className="relative text-lg font-black text-primary mt-1">{winnerText}</h1>
          <p className="relative text-sm text-text-muted">Final net score: {Math.abs(game.netScore)} pts</p>
          {error && <p className="relative text-xs font-bold text-error mt-1">{error}</p>}
        </div>

        {/* Final captured piles — the match's actual result stays visible, not just a text
            summary, so "who took what" is still here to look back over. */}
        <main className="flex-1 overflow-y-auto p-4 space-y-3 pb-28">
          {[0, 1].map((team) => {
            const cards = team === 0 ? capturedByTeam.team0 : capturedByTeam.team1;
            return (
              <div key={team} className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-black" style={{ color: TEAM_COLOR[team as 0 | 1] }}>
                    {TEAM_LABEL[team as 0 | 1]}{game.winnerTeam === team ? ' 🏆' : ''}
                  </span>
                  <span className="text-xs font-bold text-text-muted">{sumPoints(cards)} pts · {cards.length} cards</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {sortHandForDisplay(cards).map((c: string, i: number) => {
                    const { rank, suit } = parseCard(c);
                    const red = SUIT_RED[suit];
                    return (
                      <span
                        key={`${c}-${i}`}
                        className={clsx(
                          'w-6 h-8 rounded border border-border-subtle bg-white flex flex-col items-center justify-center text-[9px] font-bold shrink-0',
                          red ? 'text-error' : 'text-on-surface',
                        )}
                      >
                        <span>{rank}</span>
                        <span className="text-[10px] leading-none">{SUIT_SYMBOL[suit]}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </main>

        <div className="fixed bottom-0 inset-x-0 bg-white border-t border-border-subtle p-3 flex items-center gap-2 z-20">
          {isPlayer && (
            <button
              onClick={() => (game.rematchGameId ? navigate(`/games/sweep/${game.rematchGameId}`) : handlePlayAgain())}
              disabled={busy}
              className="flex-1 py-3 bg-success text-white font-bold rounded-2xl disabled:opacity-50 text-sm"
            >
              {game.rematchGameId ? 'Join Rematch' : busy ? 'Starting…' : 'Play Again'}
            </button>
          )}
          <button onClick={() => navigate('/games/sweep')} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl text-sm">
            Back to Lobby
          </button>
          {user.uid === game.hostUid && (
            <button onClick={handleDeleteGame} className="p-3 text-error/70" aria-label="Delete game">
              <span className="material-symbols-outlined text-[20px] block">delete</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---- Deal summary (between deals, still mid-match) ----
  if (game.status === 'deal_end') {
    const s = game.lastDealSummary;
    return (
      <div className="flex flex-col min-h-screen bg-surface items-center justify-center p-6 text-center gap-4">
        <span className="material-symbols-outlined text-5xl text-primary">scoreboard</span>
        <h1 className="text-xl font-black text-primary">Deal {s?.dealNumber} Complete</h1>
        {s && (
          <div className="bg-white rounded-2xl border border-border-subtle p-4 space-y-2 w-full max-w-xs">
            <div className="flex justify-between text-sm">
              <span className="font-bold" style={{ color: TEAM_COLOR[0] }}>Team A</span>
              <span className="font-black">{s.teamPoints[0]} pts{s.sweepCount[0] ? ` (${s.sweepCount[0]} sweep${s.sweepCount[0] > 1 ? 's' : ''})` : ''}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="font-bold" style={{ color: TEAM_COLOR[1] }}>Team B</span>
              <span className="font-black">{s.teamPoints[1]} pts{s.sweepCount[1] ? ` (${s.sweepCount[1]} sweep${s.sweepCount[1] > 1 ? 's' : ''})` : ''}</span>
            </div>
            <p className="text-xs font-bold text-primary pt-1 border-t border-border-subtle">
              {s.winnerTeam === 'tie' ? 'Tied deal — same dealer deals again.' : `${TEAM_LABEL[s.winnerTeam as 0 | 1]} won this deal.`}
            </p>
          </div>
        )}
        <p className="text-sm text-text-muted">
          Net score: <span className="font-bold" style={{ color: TEAM_COLOR[game.netScore >= 0 ? 0 : 1] }}>{Math.abs(game.netScore)} pts for {TEAM_LABEL[game.netScore >= 0 ? 0 : 1]}</span> (100 to win)
        </p>
        {error && <p className="text-xs font-bold text-error">{error}</p>}
        {user.uid === game.hostUid ? (
          <button onClick={handleDealNext} disabled={busy} className="px-6 py-3 bg-primary text-white font-bold rounded-2xl disabled:opacity-50">
            {busy ? 'Dealing…' : 'Deal Next Hand'}
          </button>
        ) : (
          <p className="text-sm text-text-muted italic">Waiting for the host to deal the next hand…</p>
        )}
        <button onClick={handleEndGame} className="text-[10px] font-bold text-error/60">
          End Game
        </button>
      </div>
    );
  }

  // ---- Bidding ----
  if (game.status === 'bidding') {
    const bidder = game.bidderSeatIndex != null ? game.players[game.bidderSeatIndex] : null;
    const floorRevealed = game.bidValue != null;
    // Choosing a value happens fully blind — from the hand alone, no floor visibility at all for
    // ANYONE, bidder included. Only once the value is committed does the floor become public.
    const myBiddableValues = isBidder && !floorRevealed ? Array.from(new Set(handCards.map((c) => captureValue(c)))).filter((v) => v >= 9 && v <= 13) : [];
    const bidCard = floorRevealed && game.bidValue != null ? handCards.find((c) => captureValue(c) === game.bidValue) : null;
    const bidPileTotal =
      bidAction === 'capture'
        ? sumCardValues(bidFloorCards)
        : (bidCurCardId ? captureValue(bidCurCardId) : 0) + sumCardValues(bidCurFloorCards);
    const bidSetsUsedCardIds = bidSets.map((s) => s.cardId).filter((c): c is string => !!c);
    const bidSetsUsedFloorIds = bidSets.flatMap((s) => s.floorCardIds);
    const bidHasHandAnchor = bidSets.some((s) => s.cardId != null);
    const floorLoose = game.floor?.looseCards || [];
    const canCaptureFromFloor = floorRevealed && game.bidValue != null && (() => {
      // client-side hint only: does ANY non-empty floor subset sum exactly to the bid?
      const n = floorLoose.length;
      for (let mask = 1; mask < 1 << n; mask++) {
        let sum = 0;
        for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += captureValue(floorLoose[i]);
        if (sum === game.bidValue) return true;
      }
      return false;
    })();

    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <ReactionOverlay reactions={floatingReactions} />
        <header className="p-2 flex items-center gap-2 bg-white border-b border-border-subtle">
          <button onClick={() => navigate('/games/sweep')} className="text-text-muted">
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          </button>
          <h1 className="font-black text-primary text-xs">Sweep — Deal {game.dealNumber}</h1>
          <ReactionButton onSend={handleSendQuickReaction} />
          <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider bg-surface px-1.5 py-0.5 rounded-full">{game.code}</span>
          <div className="flex items-center gap-1.5 ml-auto">
            <button onClick={handleEndGame} className="p-2 text-error shrink-0" aria-label="Leave game">
              <span className="material-symbols-outlined text-[22px] block">logout</span>
            </button>
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
        </header>
        {showHelp && <GameHelpModal content={SWEEP_HELP} onClose={() => setShowHelp(false)} />}
        {showChat && user && (
          <ChatPanel
            collectionName="sweepGames"
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
        <main className="flex-1 p-3 max-w-xl mx-auto w-full space-y-3 pb-24">
          {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

          <div className="bg-white rounded-xl border border-border-subtle p-3 text-center">
            <p className="text-sm font-bold text-primary">
              {!floorRevealed
                ? isBidder
                  ? 'Your bid — choose a value from your hand'
                  : `${bidder?.displayName || '…'} is choosing a bid…`
                : isBidder
                ? `You bid ${game.bidValue} — decide how to own it`
                : `${bidder?.displayName || '…'} bid ${game.bidValue} — deciding how to own it…`}
            </p>
          </div>

          <div>
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1 mb-1">
              {floorRevealed ? 'Floor' : 'Floor (hidden until the bid is committed)'}
            </p>
            <div className="flex gap-1.5">
              {floorRevealed
                ? floorLoose.map((c) => {
                    const usedInSet = bidAction === 'house' && bidSetsUsedFloorIds.includes(c);
                    return (
                      <CardChip
                        key={c}
                        cardId={c}
                        size="played"
                        dim={usedInSet}
                        selected={bidAction === 'capture' ? bidFloorCards.includes(c) : bidCurFloorCards.includes(c)}
                        onClick={
                          isBidder && bidAction === 'capture'
                            ? () => toggleFloorCard(setBidFloorCards, c)
                            : isBidder && bidAction === 'house' && !usedInSet
                            ? () => toggleFloorCard(setBidCurFloorCards, c)
                            : undefined
                        }
                      />
                    );
                  })
                : Array.from({ length: game.floorHiddenCount }).map((_, i) => <CardChip key={i} cardId="" faceDown size="played" />)}
            </div>
          </div>

          {isBidder && !floorRevealed && (
            <div className="space-y-3">
              <div>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1 mb-1">Your Hand</p>
                <div className="flex gap-1.5">
                  {sortHandForDisplay(handCards).map((c) => (
                    <CardChip key={c} cardId={c} dim={captureValue(c) < 9} />
                  ))}
                </div>
              </div>

              {myBiddableValues.length === 0 ? (
                <p className="text-xs text-text-muted italic px-1">No card worth 9+ — this hand can't bid.</p>
              ) : (
                <div className="space-y-2">
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1 mb-1">Bid Value</p>
                  <div className="flex gap-1.5">
                    {myBiddableValues.map((v) => (
                      <button
                        key={v}
                        onClick={() => setBidValue(v === bidValue ? null : v)}
                        disabled={busy}
                        className={`w-10 h-10 rounded-lg text-sm font-black border disabled:opacity-50 ${
                          bidValue === v ? 'bg-primary text-white border-primary' : 'bg-white border-border-subtle'
                        }`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                  {bidValue != null && (
                    <button
                      onClick={() => handleSubmitBidValue(bidValue)}
                      disabled={busy}
                      className="w-full py-2.5 bg-success text-white font-bold rounded-lg text-sm disabled:opacity-40"
                    >
                      {busy ? 'Committing…' : `Commit Bid: ${bidValue}`}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {isBidder && floorRevealed && (
            <div className="space-y-3">
              <div>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1 mb-1">Your Hand</p>
                <div className="flex gap-1.5">
                  {sortHandForDisplay(handCards).map((c) => {
                    const usedInSet = bidAction === 'house' && bidSetsUsedCardIds.includes(c);
                    return (
                      <CardChip
                        key={c}
                        cardId={c}
                        dim={usedInSet}
                        selected={bidAction === 'house' && bidCurCardId === c}
                        onClick={
                          bidAction === 'house' && c !== bidCard && !usedInSet
                            ? () => setBidCurCardId(c === bidCurCardId ? null : c)
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex gap-1.5 flex-wrap">
                  {(['capture', 'house', 'throw'] as ActionMode[])
                    .filter((a) => a !== 'throw' || !canCaptureFromFloor)
                    .map((a) => (
                      <button
                        key={a}
                        onClick={() => {
                          setBidAction(a);
                          setBidFloorCards([]);
                          setBidSets([]);
                          setBidCurCardId(null);
                          setBidCurFloorCards([]);
                        }}
                        className={`flex-1 py-2 rounded-lg text-xs font-bold border ${bidAction === a ? 'bg-primary text-white border-primary' : 'bg-white border-border-subtle'}`}
                      >
                        {a === 'capture' ? 'Capture' : a === 'house' ? 'Build House' : 'Throw Loose'}
                      </button>
                    ))}
                </div>
                {bidAction === 'capture' && (
                  <p className="text-xs text-text-muted px-1">
                    Tap floor cards summing to exactly {game.bidValue}. Selected total: <span className="font-bold">{bidPileTotal}</span>
                  </p>
                )}
                {bidAction === 'house' && (
                  <div className="space-y-2">
                    <p className="text-xs text-text-muted px-1">
                      Tap a DIFFERENT card in your hand above (optional after the first set), then floor cards, so they sum to {game.bidValue} — then Add Set. Your bid card stays in hand as the key. Current total: <span className="font-bold">{bidPileTotal}</span>
                    </p>
                    {bidSets.length > 0 && (
                      <div className="space-y-1">
                        {bidSets.map((s, i) => (
                          <div key={i} className="flex items-center gap-1.5 bg-surface rounded-lg p-1.5">
                            <div className="flex gap-1 flex-1">
                              {[...(s.cardId ? [s.cardId] : []), ...s.floorCardIds].map((c) => (
                                <CardChip key={c} cardId={c} size="played" />
                              ))}
                            </div>
                            <button onClick={() => handleRemoveBidSet(i)} className="text-error text-[10px] font-bold px-1">
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={handleAddBidSet}
                      disabled={busy || bidPileTotal !== game.bidValue}
                      className="w-full py-2 bg-primary/10 text-primary font-bold rounded-lg text-xs disabled:opacity-40"
                    >
                      Add Set
                    </button>
                  </div>
                )}
                <button
                  onClick={handleResolveBid}
                  disabled={
                    busy ||
                    !bidAction ||
                    (bidAction === 'capture' && bidPileTotal !== game.bidValue) ||
                    (bidAction === 'house' && (bidSets.length === 0 || !bidHasHandAnchor))
                  }
                  className="w-full py-2.5 bg-success text-white font-bold rounded-lg text-sm disabled:opacity-40"
                >
                  Submit
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  // ---- Active game ----
  const floor: SweepFloor = game.floor;
  const value = selectedCard ? captureValue(selectedCard) : null;
  // A capture is offered whenever the played card can take anything at all — a direct single
  // loose-card/house match, OR a combination of loose cards (e.g. 9+2) summing to it.
  const captureAvailable = value != null && canCaptureValue(floor, value);
  const canAct = isMyTurn && !busy;
  // Cards that each independently match the house's target number (the played card's own value
  // when staking a brand-new house, or the selected house's number when adding to one) form their
  // own one-card sets instead of being summed together — mirrors the server's house-building rule.
  const houseTargetValue = selectedHouseId ? floor.houses.find((h) => h.id === selectedHouseId)?.value ?? null : value;
  const allMatchHouseTarget =
    houseTargetValue != null &&
    houseTargetValue >= 9 &&
    houseTargetValue <= 13 &&
    value === houseTargetValue &&
    selectedFloorCards.every((c) => captureValue(c) === houseTargetValue);
  const pileTotal = allMatchHouseTarget ? houseTargetValue! : value != null ? sumCardValues(selectedFloorCards) + value : 0;
  const turnPlayer = game.players[game.currentTurnSeatIndex];
  const availableActions: ActionMode[] = captureAvailable ? ['capture', 'house'] : ['house', 'throw'];
  // Running captured-points tally for THIS deal only (capturedByTeam resets each deal, same as
  // the rest of this screen's live state) — not the match-level net score shown alongside it.
  const teamACapturedPoints = (game.capturedByTeam?.team0 || []).reduce((sum, c) => sum + cardPoints(c), 0);
  const teamBCapturedPoints = (game.capturedByTeam?.team1 || []).reduce((sum, c) => sum + cardPoints(c), 0);

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <ReactionOverlay reactions={floatingReactions} />

      {sweepCelebration && (
        <div className="fixed inset-x-0 top-14 z-50 flex justify-center pointer-events-none px-6">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setSweepCelebration(null)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSweepCelebration(null); }}
            className="pointer-events-auto cursor-pointer px-5 py-3 rounded-2xl shadow-2xl text-center animate-bounce max-w-xs"
            style={{ background: TEAM_COLOR[sweepCelebration.team], color: 'white' }}
          >
            <p className="text-2xl mb-0.5">🧹💨</p>
            <p className="text-sm font-black leading-snug">{sweepCelebration.msg}</p>
            <p className="text-[10px] font-bold opacity-80 mt-1">{TEAM_LABEL[sweepCelebration.team]} sweeps the floor! · tap to dismiss</p>
          </div>
        </div>
      )}
      {/* GameHelpModal/ChatPanel render OUTSIDE the fixed wrapper below, as top-level siblings —
          a `position:fixed` ancestor with its own z-index (the wrapper below is `z-30`) creates a
          new stacking context, and z-index only ever competes among siblings *within* the same
          stacking context. Nested inside it, a modal's `z-[280]` would only out-rank siblings
          inside that z-30 context, not the real page-level bottom Navigation bar (`z-50`), which
          sits in the page's root stacking context alongside this wrapper itself — see
          RummyGame.tsx for the full writeup of this exact bug (the chat input became untappable
          near the bottom of the screen). */}
      {showHelp && <GameHelpModal content={SWEEP_HELP} onClose={() => setShowHelp(false)} />}
      {showChat && user && (
        <ChatPanel
          collectionName="sweepGames"
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
      {/* The ENTIRE screen is pinned between the global app Header (`min-h-[60px]`) and the fixed
          bottom Navigation bar (`h-16` = 64px) — see RummyGame.tsx for the full rationale on this
          `position: fixed` technique. Everything through the Team A/Net/Team B status card is
          `shrink-0` and never scrolls; only the floor/hand/history area below it does. */}
      <div className="fixed inset-x-0 top-[60px] bottom-16 z-30 flex flex-col bg-surface overflow-hidden">
      <div className="shrink-0">
      <header className="p-2 flex items-center gap-2 flex-wrap bg-white border-b border-border-subtle shrink-0">
        <button onClick={() => navigate('/games/sweep')} className="text-text-muted">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
        </button>
        <h1 className="font-black text-primary text-xs shrink-0">Sweep — Deal {game.dealNumber}</h1>
        <ReactionButton onSend={handleSendQuickReaction} />
        <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider bg-surface px-1.5 py-0.5 rounded-full shrink-0">{game.code}</span>
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          <button onClick={handleEndGame} className="p-2 text-error shrink-0" aria-label="Leave game">
            <span className="material-symbols-outlined text-[22px] block">logout</span>
          </button>
          <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
          <HelpButton onClick={() => setShowHelp(true)} />
        </div>
        <span className="text-[11px] font-bold whitespace-nowrap text-primary shrink-0 w-full text-right">
          {isMyTurn ? 'Your turn' : `${turnPlayer?.displayName || '…'}'s turn`}
        </span>
      </header>

      <div className="p-2 max-w-xl mx-auto w-full">
        <div className="bg-white rounded-xl border border-border-subtle p-2 space-y-1.5">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {game.players.map((p, i) => (
              <div
                key={p.uid}
                className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border shrink-0 ${i === game.currentTurnSeatIndex ? 'ring-2 ring-offset-1' : ''}`}
                style={{ borderColor: TEAM_COLOR[p.team] }}
              >
                <div className="relative w-5 h-5 shrink-0">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold" style={{ background: TEAM_COLOR[p.team] }}>
                    {p.displayName?.slice(0, 1) || '?'}
                  </div>
                  <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2 h-2" />
                </div>
                <span className="text-[10px] font-bold text-on-surface whitespace-nowrap">{p.uid === user.uid ? 'You' : p.displayName}</span>
                <span className="text-[9px] text-text-muted whitespace-nowrap">{p.handCount}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-border-subtle text-[10px] font-bold">
            <span className="flex items-center gap-1">
              <span style={{ color: TEAM_COLOR[0] }}>Team A</span>
              <span className="text-text-muted font-black">{teamACapturedPoints}</span>
            </span>
            <span className="text-text-muted">
              Net: {game.netScore === 0 ? 'even' : `${Math.abs(game.netScore)} for ${TEAM_LABEL[game.netScore > 0 ? 0 : 1]}`} (100 to win)
            </span>
            <span className="flex items-center gap-1">
              <span className="text-text-muted font-black">{teamBCapturedPoints}</span>
              <span style={{ color: TEAM_COLOR[1] }}>Team B</span>
            </span>
          </div>
        </div>
      </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="p-2 max-w-xl mx-auto w-full space-y-2 pb-6">
        {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

        {/* Floor — tinted a light shade of whichever team's turn it currently is, so a glance at
            the table (not just the status card above) tells you whose turn it is. */}
        <div
          className="rounded-xl border p-2 space-y-2 transition-colors"
          style={{ backgroundColor: `${TEAM_COLOR[turnPlayer?.team ?? 0]}14`, borderColor: `${TEAM_COLOR[turnPlayer?.team ?? 0]}40` }}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider shrink-0">Floor</p>
            {game.lastAction?.text && <p className="text-[10px] font-bold text-primary text-right truncate">{game.lastAction.text}</p>}
          </div>
          {floor.houses.length === 0 && floor.looseCards.length === 0 && <p className="text-xs text-text-muted italic">Empty</p>}
          {floor.houses.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {floor.houses.map((h) => {
                // In capture mode, a house whose own value already matches the played card is
                // auto-captured by the server regardless — nothing to tap. Otherwise, only a WEAK
                // house (a single, not-yet-locked set) can be folded into a combined-value
                // capture alongside loose cards (e.g. House·10 + a loose 3, captured by a King) —
                // a strong house is locked to its own value and stays non-interactive here.
                const isAutoIncludedHouse = actionMode === 'capture' && value != null && h.value === value;
                const isCaptureFoldable = actionMode === 'capture' && !isAutoIncludedHouse && h.sets.length === 1;
                if (isAutoIncludedHouse) {
                  return (
                    <div key={h.id} className="relative">
                      <HouseTile house={h} players={game.players} />
                      <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-success text-white flex items-center justify-center shadow">
                        <span className="material-symbols-outlined text-[11px] leading-none">check</span>
                      </span>
                    </div>
                  );
                }
                return (
                  <HouseTile
                    key={h.id}
                    house={h}
                    players={game.players}
                    selected={actionMode === 'house' ? selectedHouseId === h.id : selectedCaptureHouseIds.includes(h.id)}
                    onClick={
                      canAct && selectedCard && actionMode === 'house'
                        ? () => setSelectedHouseId(h.id === selectedHouseId ? null : h.id)
                        : canAct && selectedCard && isCaptureFoldable
                        ? () => setSelectedCaptureHouseIds((s) => (s.includes(h.id) ? s.filter((x) => x !== h.id) : [...s, h.id]))
                        : undefined
                    }
                  />
                );
              })}
            </div>
          )}
          {floor.looseCards.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {floor.looseCards.map((c) => {
                // In capture mode, a loose card whose own value already matches the played card
                // is auto-captured by the server regardless — shown as a fixed "included" chip,
                // not a toggle, so there's nothing to tap-and-break by re-selecting it.
                const isAutoIncluded = actionMode === 'capture' && value != null && captureValue(c) === value;
                if (isAutoIncluded) {
                  return (
                    <div key={c} className="relative">
                      <CardChip cardId={c} size="played" />
                      <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-success text-white flex items-center justify-center shadow">
                        <span className="material-symbols-outlined text-[11px] leading-none">check</span>
                      </span>
                    </div>
                  );
                }
                return (
                  <CardChip
                    key={c}
                    cardId={c}
                    size="played"
                    selected={selectedFloorCards.includes(c)}
                    onClick={canAct && selectedCard && (actionMode === 'house' || actionMode === 'capture') ? () => toggleFloorCard(setSelectedFloorCards, c) : undefined}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Action panel — only once a card is selected */}
        {selectedCard && (
          <div className="bg-white rounded-xl border-2 border-primary p-3 space-y-2">
            <p className="text-xs font-bold text-on-surface">
              Playing <span className="text-primary">{parseCard(selectedCard).rank}{SUIT_SYMBOL[parseCard(selectedCard).suit]}</span> (value {value})
            </p>
            <div className="flex gap-1.5 flex-wrap">
              {availableActions.map((a) => (
                <button
                  key={a}
                  onClick={() => { setActionMode(a); setSelectedFloorCards([]); setSelectedHouseId(null); setSelectedCaptureHouseIds([]); }}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border ${
                    actionMode === a ? (a === 'capture' ? 'bg-success text-white border-success' : 'bg-primary text-white border-primary') : 'bg-white border-border-subtle'
                  }`}
                >
                  {a === 'capture' ? 'Capture' : a === 'house' ? 'Build / Add to House' : 'Throw Loose'}
                </button>
              ))}
            </div>
            {actionMode === 'capture' && (
              <p className="text-[11px] text-text-muted">
                Matching cards/houses capture automatically. Optionally tap other loose cards — or a weak (single-set) house, to fold its value in — to sweep them in too.
                One or more separate groups each worth {value} all work (e.g. a 5+6 AND a separate House·7-plus-loose-4, in the same play). Extra total:{' '}
                <span className="font-bold">
                  {sumCardValues(selectedFloorCards) + selectedCaptureHouseIds.reduce((sum, id) => sum + (floor.houses.find((h) => h.id === id)?.value || 0), 0)}
                </span>
              </p>
            )}
            {actionMode === 'house' && !selectedHouseId && (
              <p className="text-[11px] text-text-muted">
                {allMatchHouseTarget && selectedFloorCards.length > 0
                  ? <>Matching-value cards each form their own set — instant House·{pileTotal}.</>
                  : <>Tap loose floor cards to combine with your card, or select none to stake it as its own house. Total: <span className="font-bold">{pileTotal}</span> (must be 9-13)</>}
              </p>
            )}
            {actionMode === 'house' && selectedHouseId && (
              <p className="text-[11px] text-text-muted">
                {allMatchHouseTarget && selectedFloorCards.length > 0
                  ? <>Matching-value cards each form their own set on this house.</>
                  : <>Adding to the selected house. Tap loose floor cards to include. Total: <span className="font-bold">{pileTotal}</span></>}
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => actionMode && handlePlay(actionMode)}
                disabled={busy || !actionMode}
                className="flex-1 py-2 bg-primary text-white font-bold rounded-lg text-sm disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                onClick={() => { setSelectedCard(null); setActionMode(null); setSelectedFloorCards([]); setSelectedHouseId(null); setSelectedCaptureHouseIds([]); }}
                className="px-4 py-2 bg-white border border-border-subtle rounded-lg text-sm font-bold"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Hand */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-bold text-text-muted uppercase px-1">Your Hand ({handSorted.length})</p>
          <div className="flex gap-1.5 flex-wrap">
            {handSorted.map((c) => (
              <CardChip
                key={c}
                cardId={c}
                selected={selectedCard === c}
                onClick={canAct ? () => setSelectedCard(c === selectedCard ? null : c) : undefined}
              />
            ))}
          </div>
        </div>

        {(game.dealHistory || []).length > 0 && (
          <div className="space-y-1.5 pt-2">
            <p className="text-[10px] font-bold text-text-muted uppercase px-1">Deal History</p>
            <div className="space-y-2">
              {game.dealHistory.map((d) => {
                const expanded = expandedDeals.has(d.dealNumber);
                const dealNet = d.teamPoints[0] - d.teamPoints[1];
                return (
                  <div key={d.dealNumber} className="bg-white rounded-xl border border-border-subtle overflow-hidden">
                    <button onClick={() => toggleDealExpanded(d.dealNumber)} className="w-full p-2 flex items-center gap-2 text-left">
                      <span className="material-symbols-outlined text-[16px] text-text-muted shrink-0">
                        {expanded ? 'expand_less' : 'expand_more'}
                      </span>
                      <span className="text-[10px] font-bold text-text-muted shrink-0">Deal {d.dealNumber}</span>
                      <span className="text-[10px] font-black shrink-0" style={{ color: TEAM_COLOR[0] }}>
                        A {d.teamPoints[0]}
                      </span>
                      <span className="text-[10px] font-black shrink-0" style={{ color: TEAM_COLOR[1] }}>
                        B {d.teamPoints[1]}
                      </span>
                      <span className="ml-auto text-right shrink-0">
                        <span className="block text-[10px] font-bold text-text-muted">
                          {dealNet === 0 ? 'Tied' : `+${Math.abs(dealNet)} ${TEAM_LABEL[dealNet > 0 ? 0 : 1]}`}
                        </span>
                        <span className="block text-[9px] font-bold text-primary">
                          Cum: {d.netScoreAfter === 0 ? 'even' : `${Math.abs(d.netScoreAfter)} ${TEAM_LABEL[d.netScoreAfter > 0 ? 0 : 1]}`}
                        </span>
                      </span>
                    </button>
                    {expanded && (
                      <div className="px-2 pb-2 space-y-1.5 border-t border-border-subtle pt-1.5">
                        {([0, 1] as const).map((t) => {
                          const valueCards = (t === 0 ? d.capturedByTeam.team0 : d.capturedByTeam.team1).filter((c) => cardPoints(c) > 0);
                          return (
                            <div key={t} className="flex items-center gap-1.5">
                              <span className="text-[10px] font-bold w-14 shrink-0" style={{ color: TEAM_COLOR[t] }}>
                                {TEAM_LABEL[t]}
                              </span>
                              <span className="text-[10px] font-black shrink-0">{d.teamPoints[t]} pts</span>
                              <div className="flex gap-1 flex-wrap overflow-x-auto">
                                {valueCards.length === 0 ? (
                                  <span className="text-[10px] text-text-muted italic">no value cards</span>
                                ) : (
                                  valueCards.map((c, i) => <CardChip key={`${c}-${i}`} cardId={c} size="played" />)
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      </div>
      </div>
    </div>
  );
}
