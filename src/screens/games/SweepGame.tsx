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
import { VoiceChatButton, useGameVoice } from '../../components/GameVoiceChat';
import InvitePicker from '../../components/InvitePicker';
import PresenceDot from '../../components/PresenceDot';
import ShareGameButton from '../../components/ShareGameButton';
import { useGameTurnPresence } from '../../lib/gameTurnPresence';
import Fireworks from '../../components/Fireworks';
import ShareWinButton from '../../components/ShareWinButton';
import { buildWinShare } from '../../lib/winShareImage';

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

// Felt-table playing card. 'hand' = big card in your fan, 'floor' = card on the table, 'mini' = history.
const CARD_SIZES = {
  hand: 'w-14 h-20 rounded-lg text-[1.35rem]',
  floor: 'w-[2.9rem] h-[4.2rem] rounded-lg text-[1.1rem]',
  mini: 'w-7 h-10 rounded text-[0.7rem]',
} as const;

const CardChip: React.FC<{
  cardId: string;
  selected?: boolean; // lifted, gold ring (hand card you're playing)
  picked?: boolean; // green glow (floor card you've chosen)
  dim?: boolean;
  faceDown?: boolean;
  onClick?: () => void;
  size?: keyof typeof CARD_SIZES;
  className?: string;
  style?: React.CSSProperties;
}> = ({ cardId, selected, picked, dim, faceDown, onClick, size = 'floor', className, style }) => {
  const dims = CARD_SIZES[size];
  if (faceDown) {
    return (
      <div
        className={clsx(dims, 'shrink-0 border-2 border-slate-200 shadow-[0_3px_0_rgba(0,0,0,0.25),0_6px_10px_rgba(0,0,0,0.3)]', className)}
        style={{ background: 'repeating-linear-gradient(45deg,#0b3a57 0 6px,#0f4c73 6px 12px)', ...style }}
      />
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
      style={style}
      className={clsx(
        'relative shrink-0 bg-white border border-slate-300 flex items-center justify-center font-black leading-none transition-all shadow-[0_3px_0_rgba(0,0,0,0.25),0_6px_10px_rgba(0,0,0,0.3)]',
        dims,
        onClick && 'cursor-pointer active:scale-95',
        selected && 'ring-[3px] ring-amber-400 shadow-[0_8px_14px_rgba(0,0,0,0.4)]',
        picked && 'ring-[3px] ring-green-500 shadow-[0_0_14px_#22c55e]',
        dim && 'opacity-40',
        red ? 'text-red-600' : 'text-slate-900',
        className,
      )}
    >
      <span className={clsx('absolute font-black', size === 'mini' ? 'top-0.5 left-[3px] text-[0.55rem]' : 'top-[3px] left-[5px] text-[0.7rem]')}>{rank}</span>
      <span className={size === 'mini' ? 'text-[0.95rem]' : size === 'hand' ? 'text-[1.7rem] mt-2' : 'text-[1.4rem] mt-1.5'}>{SUIT_SYMBOL[suit]}</span>
    </div>
  );
};

// A house on the floor: its sets as rows of overlapped cards, outlined in the owning team's colour.
const HouseTile: React.FC<{
  house: SweepHouse;
  players: SweepGameDoc['players'];
  selected?: boolean;
  onClick?: () => void;
  included?: boolean;
}> = ({ house, selected, onClick, included }) => {
  const color = TEAM_COLOR[house.ownerTeams[0] ?? 0];
  const strong = house.sets.length > 1;
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      className={clsx('relative rounded-2xl bg-black/25 border-2 p-2 shrink-0 space-y-1.5', onClick && 'cursor-pointer active:scale-[0.98]', selected && 'ring-[3px] ring-green-500 shadow-[0_0_14px_#22c55e]')}
      style={{ borderColor: color }}
    >
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <span className="text-[10px] font-black px-2 py-0.5 rounded-full text-white" style={{ background: color }}>HOUSE · {house.value}</span>
        {strong && <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-amber-400 text-amber-950">STRONG</span>}
        {included && (
          <span className="ml-auto w-5 h-5 rounded-full bg-green-500 text-white flex items-center justify-center shadow">
            <span className="material-symbols-outlined text-[13px] leading-none">check</span>
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {house.sets.map((s, i) => (
          <div key={i} className="flex">
            {s.cards.map((c, j) => (
              <CardChip key={c} cardId={c} size="floor" className={j > 0 ? '-ml-3' : ''} />
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
  const voice = useGameVoice('sweepGames', gameId, game?.players || []);

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
      const t = setTimeout(() => setSweepCelebration(null), 3200);
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

  const handleFillBot = async () => {
    await call('/api/sweep/fill-bot', {}).catch(() => {});
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
          <h1 className="font-black text-primary">Sweep</h1>
          <ReactionButton onSend={handleSendQuickReaction} />
          <div className="flex items-center gap-1.5 ml-auto">
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
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
                          <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0 overflow-hidden" style={{ background: TEAM_COLOR[t] }}>
                            {p.isBot ? '🤖' : p.photoURL ? (
                              <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              p.displayName?.slice(0, 1) || '?'
                            )}
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
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold overflow-hidden" style={{ background: TEAM_COLOR[p.team] }}>
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

          {isPlayer && user.uid === game.hostUid && game.players.length < game.playerCount && (
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
    const teamNames = (t: number) => game.players.filter((p) => p.team === t).map((p) => p.displayName).join(' & ');
    const winShare = game.winnerTeam != null && me && me.team === game.winnerTeam
      ? buildWinShare({
          gameName: 'Sweep',
          winnerLabel: teamNames(game.winnerTeam),
          standings: [game.winnerTeam, game.winnerTeam === 0 ? 1 : 0].map((t) => ({
            name: teamNames(t),
            label: `${sumPoints(t === 0 ? capturedByTeam.team0 : capturedByTeam.team1)} pts`,
            isWinner: t === game.winnerTeam,
          })),
          detail: `Final net score ${Math.abs(game.netScore)} pts`,
        })
      : null;
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <div className="relative shrink-0 bg-primary/5 border-b border-border-subtle px-4 py-4 text-center overflow-hidden">
          <Fireworks />
          <span className="relative text-4xl">🏆</span>
          <h1 className="relative text-lg font-black text-primary mt-1">{winnerText}</h1>
          <p className="relative text-sm text-text-muted">Final net score: {Math.abs(game.netScore)} pts</p>
          {error && <p className="relative text-xs font-bold text-error mt-1">{error}</p>}
          {winShare && <ShareWinButton card={winShare.card} caption={winShare.caption} className="relative mt-3" />}
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
          <button onClick={() => navigate('/tools?category=games')} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl text-sm">
            Back to Games
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

  // ---- Shared felt-table shell for the bidding + play screens ----
  // Full-screen over the app header / tab bar (same immersive layout as Rummy, Ludo and Business):
  // header, score strip, player pills, a turn banner, the green table (scrolls), and a dock with your
  // hand and the main action button.
  const teamACapturedPoints = (game.capturedByTeam?.team0 || []).reduce((sum, c) => sum + cardPoints(c), 0);
  const teamBCapturedPoints = (game.capturedByTeam?.team1 || []).reduce((sum, c) => sum + cardPoints(c), 0);
  const netLead = game.netScore === 0 ? null : game.netScore > 0 ? 0 : 1;
  const netPct = Math.min(100, Math.abs(game.netScore));

  // Your hand as an overlapped fan that always fits the screen width.
  const renderHandFan = (cards: string[], opts: { selected?: (c: string) => boolean; dim?: (c: string) => boolean; onTap?: (c: string) => (() => void) | undefined }) => {
    const cardW = 56;
    const avail = Math.min(typeof window !== 'undefined' ? window.innerWidth : 400, 448) - 32;
    const step = cards.length > 1 ? Math.min(cardW + 6, (avail - cardW) / (cards.length - 1)) : 0;
    const width = step * Math.max(0, cards.length - 1) + cardW;
    return (
      <div className="relative mx-auto h-[6.2rem]" style={{ width }}>
        {cards.map((c, i) => {
          const sel = !!opts.selected?.(c);
          return (
            <CardChip
              key={c}
              cardId={c}
              size="hand"
              selected={sel}
              dim={opts.dim?.(c)}
              onClick={opts.onTap?.(c)}
              className="!absolute"
              style={{ left: i * step, top: sel ? 2 : 16, zIndex: sel ? 50 : i }}
            />
          );
        })}
      </div>
    );
  };

  const renderShell = (opts: { banner: string; bannerColor: string; table: React.ReactNode; tableFooter?: React.ReactNode; dock: React.ReactNode }) => (
    <div className="flex flex-col min-h-screen bg-surface">
      <ReactionOverlay reactions={floatingReactions} />

      {sweepCelebration && (() => {
        const tc = TEAM_COLOR[sweepCelebration.team];
        const confetti = Array.from({ length: 28 }).map((_, i) => {
          const ang = (i / 28) * Math.PI * 2 + (i % 3) * 0.2;
          const dist = 110 + ((i * 37) % 90);
          return { dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist, color: ['#fbbf24', '#f87171', '#60a5fa', '#4ade80', '#fff', '#c084fc'][i % 6], delay: (i % 7) * 0.04, rot: (i * 57) % 360 };
        });
        return (
          <div
            role="button"
            tabIndex={0}
            onClick={() => setSweepCelebration(null)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSweepCelebration(null); }}
            className="fixed inset-0 z-[230] flex items-center justify-center cursor-pointer overflow-hidden"
            style={{ background: `radial-gradient(circle at 50% 45%, ${tc}55, rgba(0,0,0,0.78) 70%)`, animation: 'swpFade 0.25s ease-out' }}
          >
            <style>{`
              @keyframes swpFade{from{opacity:0}to{opacity:1}}
              @keyframes swpPop{0%{transform:scale(.2) rotate(-8deg);opacity:0}55%{transform:scale(1.25) rotate(3deg);opacity:1}100%{transform:scale(1) rotate(-2deg)}}
              @keyframes swpBroom{0%{transform:translateX(-130vw) rotate(-20deg)}100%{transform:translateX(130vw) rotate(-20deg)}}
              @keyframes swpDust{0%{transform:translateX(-130vw);opacity:0}30%{opacity:.9}100%{transform:translateX(130vw);opacity:0}}
              @keyframes swpBurst{0%{transform:translate(0,0) rotate(0) scale(.4);opacity:1}100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(1);opacity:0}}
              @keyframes swpRise{0%{transform:translateY(16px);opacity:0}100%{transform:translateY(0);opacity:1}}
            `}</style>
            {/* the broom wipes across the table */}
            <span className="absolute top-[34%] text-[5.5rem] leading-none" style={{ animation: 'swpBroom 0.95s cubic-bezier(.5,0,.4,1) both' }}>🧹</span>
            <span className="absolute top-[40%] text-[4rem] leading-none" style={{ animation: 'swpDust 0.95s cubic-bezier(.5,0,.4,1) 0.05s both' }}>💨</span>
            {/* confetti burst from the centre */}
            <div className="absolute left-1/2 top-1/2">
              {confetti.map((c, i) => (
                <i
                  key={i}
                  className="absolute block w-2 h-3 rounded-[2px]"
                  style={{ background: c.color, ['--dx' as any]: `${c.dx}px`, ['--dy' as any]: `${c.dy}px`, ['--rot' as any]: `${c.rot}deg`, animation: `swpBurst 1.2s ease-out ${0.45 + c.delay}s both` }}
                />
              ))}
            </div>
            <div className="relative text-center px-6" style={{ animation: 'swpPop 0.6s cubic-bezier(.2,1.3,.4,1) 0.35s both' }}>
              <p className="text-[4.2rem] leading-none font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-amber-100 via-amber-300 to-amber-600 drop-shadow-[0_6px_0_rgba(0,0,0,0.45)]" style={{ filter: `drop-shadow(0 0 22px ${tc})` }}>
                SWEEP!
              </p>
              <p className="mt-3 text-sm font-extrabold text-white max-w-[16rem] mx-auto leading-snug" style={{ animation: 'swpRise 0.4s ease-out 0.8s both' }}>{sweepCelebration.msg}</p>
              <p className="mt-3 inline-block px-4 py-1.5 rounded-full text-xs font-black text-white shadow-lg" style={{ background: tc, animation: 'swpRise 0.4s ease-out 0.95s both' }}>
                {TEAM_LABEL[sweepCelebration.team]} · +{game.sweepPoints} pts
              </p>
            </div>
          </div>
        );
      })()}
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

      <div className="fixed inset-0 z-[150] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white bg-[radial-gradient(ellipse_at_50%_35%,#1b6b52_0%,#0e3f2f_55%,#06241b_100%)]">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40 [background-image:radial-gradient(rgba(255,255,255,0.14)_1px,transparent_1.5px)] [background-size:24px_24px]" />

        <header className="relative shrink-0 flex items-center gap-2 px-3 pt-2">
          <button onClick={() => navigate('/games/sweep')} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center" aria-label="Back">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <div className="leading-tight">
            <h1 className="text-[15px] font-black">Sweep · Deal {game.dealNumber}</h1>
            <span className="text-[8px] font-bold tracking-[0.14em] text-white/60">ROOM {game.code}</span>
          </div>
          <ReactionButton onSend={handleSendQuickReaction} />
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
            <HelpButton onClick={() => setShowHelp(true)} className="!text-white" />
            <button onClick={handleEndGame} className="p-1.5 text-red-300 shrink-0" aria-label="Leave game">
              <span className="material-symbols-outlined text-[22px] block">logout</span>
            </button>
          </div>
        </header>

        {/* score strip */}
        <div className="relative shrink-0 mx-3 mt-2 rounded-2xl bg-black/35 border border-white/12 px-3 py-2">
          <div className="flex items-center justify-between text-[13px] font-black">
            <span style={{ color: '#7db4ff' }}>TEAM A · {teamACapturedPoints}</span>
            <span className="text-[9px] tracking-wider text-white/55">FIRST TO 100</span>
            <span style={{ color: '#ff8f8f' }}>{teamBCapturedPoints} · TEAM B</span>
          </div>
          <div className="relative h-[7px] rounded-full bg-white/12 my-1.5 overflow-hidden">
            {netLead === 0 && <i className="absolute left-0 inset-y-0 bg-gradient-to-r from-blue-500 to-blue-400" style={{ width: `${netPct}%` }} />}
            {netLead === 1 && <i className="absolute right-0 inset-y-0 bg-gradient-to-l from-red-500 to-red-400" style={{ width: `${netPct}%` }} />}
          </div>
          <p className="text-center text-[10px] font-bold text-white/65">
            Net: {netLead == null ? 'even' : `${Math.abs(game.netScore)} for ${TEAM_LABEL[netLead]}`}
          </p>
        </div>

        {/* player pills */}
        <div className="relative shrink-0 flex flex-wrap items-center justify-center gap-1.5 px-3 pt-2">
          {game.players.map((p, i) => {
            const active = i === game.currentTurnSeatIndex;
            const color = TEAM_COLOR[p.team];
            return (
              <div
                key={p.uid}
                className={clsx('flex items-center gap-2 h-11 rounded-full p-1 pr-3 border-2 backdrop-blur-sm', game.players.length > 2 ? 'w-[calc(50%-0.2rem)]' : 'min-w-[9.5rem]', active ? 'bg-black/55' : 'bg-black/35 border-white/15')}
                style={active ? { borderColor: color, boxShadow: `0 0 0 2px #fff, 0 0 16px ${color}` } : undefined}
              >
                <div className="relative w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-sm font-black bg-slate-700" style={{ border: `3px solid ${color}` }}>
                  <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center">
                    {p.isBot ? <span className="text-base leading-none">🤖</span> : p.photoURL ? <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : p.displayName?.slice(0, 1) || '?'}
                  </div>
                  <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2 h-2" />
                </div>
                <div className="min-w-0 leading-tight">
                  <p className="text-[11px] font-extrabold truncate">{p.uid === user.uid ? 'You' : p.displayName}</p>
                  <p className="text-[10px] font-black text-amber-200">🂠 {p.handCount} cards</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* turn banner */}
        <div className="relative shrink-0 flex justify-center pt-2">
          <span className="px-4 py-1 rounded-full text-[11px] font-black tracking-wide" style={{ background: opts.bannerColor, boxShadow: `0 0 18px ${opts.bannerColor}99` }}>
            {opts.banner}
          </span>
        </div>

        {/* the table */}
        <div className="relative flex-1 min-h-0 mx-2.5 mt-2.5 rounded-3xl bg-black/15 border border-white/10 shadow-[inset_0_6px_30px_rgba(0,0,0,0.35)] flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">{opts.table}</div>
          {opts.tableFooter && <div className="shrink-0 border-t border-white/10 bg-black/25 p-2.5 space-y-2">{opts.tableFooter}</div>}
        </div>

        {/* dock: your hand + the main button */}
        <div className="relative shrink-0 px-3 pt-1 pb-3 space-y-1.5">
          {error && <p className="text-xs font-bold text-red-300 text-center">{error}</p>}
          {opts.dock}
        </div>
      </div>
    </div>
  );

  const lblCls = 'text-[9px] tracking-[0.16em] font-black text-white/55 uppercase';
  const goBtn = 'w-full py-3 rounded-full text-[15px] font-black tracking-wide text-white bg-gradient-to-b from-green-400 to-green-700 shadow-[0_5px_0_#0f5f2e,0_9px_16px_rgba(0,0,0,0.4)] active:translate-y-[3px] active:shadow-[0_2px_0_#0f5f2e] disabled:opacity-40 disabled:shadow-[0_5px_0_#334155] disabled:from-slate-500 disabled:to-slate-600';
  const segWrap = 'flex gap-1.5 bg-black/35 p-1 rounded-full';
  const segBtn = (on: boolean) =>
    clsx('flex-1 text-center py-2 rounded-full text-xs font-black transition-all', on ? 'bg-gradient-to-b from-amber-300 to-amber-600 text-amber-950 shadow-[0_3px_0_#92400e]' : 'text-white/75');
  const chipHint = 'text-[11px] font-bold text-white/70 text-center leading-snug';

  // ---- Bidding ----
  if (game.status === 'bidding') {
    const bidder = game.bidderSeatIndex != null ? game.players[game.bidderSeatIndex] : null;
    const floorRevealed = game.bidValue != null;
    // Choosing a value happens fully blind — from the hand alone, no floor visibility at all for
    // ANYONE, bidder included. Only once the value is committed does the floor become public.
    const myBiddableValues = isBidder && !floorRevealed ? Array.from(new Set(handCards.map((c) => captureValue(c)))).filter((v) => v >= 9 && v <= 13).sort((a, b) => a - b) : [];
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

    const banner = !floorRevealed
      ? isBidder
        ? 'YOUR BID · PICK A CARD VALUE'
        : `${(bidder?.displayName || '…').toUpperCase()} IS CHOOSING A BID…`
      : isBidder
      ? `YOU BID ${game.bidValue} · HOW TO OWN IT?`
      : `${(bidder?.displayName || '…').toUpperCase()} BID ${game.bidValue}…`;

    const table = (
      <>
        <p className={lblCls}>{floorRevealed ? 'Floor' : 'Floor · hidden until the bid locks'}</p>
        <div className="flex flex-wrap gap-2 justify-center pt-1">
          {floorRevealed
            ? floorLoose.map((c) => {
                const usedInSet = bidAction === 'house' && bidSetsUsedFloorIds.includes(c);
                return (
                  <CardChip
                    key={c}
                    cardId={c}
                    dim={usedInSet}
                    picked={bidAction === 'capture' ? bidFloorCards.includes(c) : bidCurFloorCards.includes(c)}
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
            : Array.from({ length: game.floorHiddenCount }).map((_, i) => <CardChip key={i} cardId="" faceDown />)}
        </div>
        {!floorRevealed && <p className={clsx(chipHint, 'pt-2')}>Your bid is the number you must capture or build with this deal.</p>}

        {isBidder && !floorRevealed && (
          <div className="pt-3 space-y-2">
            {myBiddableValues.length === 0 ? (
              <p className={chipHint}>No card worth 9+ — this hand can't bid.</p>
            ) : (
              <>
                <p className={clsx(lblCls, 'text-center')}>Tap a bid</p>
                <div className="flex flex-wrap gap-3 justify-center">
                  {myBiddableValues.map((v) => (
                    <button
                      key={v}
                      onClick={() => setBidValue(v === bidValue ? null : v)}
                      disabled={busy}
                      className={clsx(
                        'w-[4.4rem] h-[4.4rem] rounded-full text-[1.7rem] font-black border-[3px] disabled:opacity-50 transition-all',
                        bidValue === v
                          ? 'bg-[radial-gradient(circle_at_35%_30%,#fde68a,#d97706)] text-amber-950 border-orange-50 shadow-[0_5px_0_#92400e,0_10px_16px_rgba(0,0,0,0.4)] scale-105'
                          : 'bg-slate-700 text-slate-300 border-slate-500 shadow-[0_4px_0_#1e293b]',
                      )}
                    >
                      {v}
                    </button>
                  ))}
                </div>
                <p className={chipHint}>Only values you hold can be bid · you hold {myBiddableValues.join(', ')}</p>
              </>
            )}
          </div>
        )}
      </>
    );

    const tableFooter =
      isBidder && floorRevealed ? (
        <>
          <div className={segWrap}>
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
                  className={segBtn(bidAction === a)}
                >
                  {a === 'capture' ? 'Capture' : a === 'house' ? 'Build House' : 'Throw'}
                </button>
              ))}
          </div>
          {bidAction === 'capture' && (
            <p className={chipHint}>
              Tap floor cards summing to exactly {game.bidValue}. Selected{' '}
              <span className={clsx('px-2 py-0.5 rounded-full font-black', bidPileTotal === game.bidValue ? 'bg-green-500 text-green-950' : 'bg-white/15 text-white')}>{bidPileTotal}</span>
            </p>
          )}
          {bidAction === 'house' && (
            <div className="space-y-1.5">
              <p className={chipHint}>
                Tap a DIFFERENT card in your hand (optional after the first set), then floor cards, so they total {game.bidValue}, then Add Set. Your bid card stays in hand as the key. Total{' '}
                <span className={clsx('px-2 py-0.5 rounded-full font-black', bidPileTotal === game.bidValue ? 'bg-green-500 text-green-950' : 'bg-white/15 text-white')}>{bidPileTotal}</span>
              </p>
              {bidSets.map((s, i) => (
                <div key={i} className="flex items-center gap-2 bg-white/10 rounded-xl p-1.5">
                  <div className="flex flex-1">
                    {[...(s.cardId ? [s.cardId] : []), ...s.floorCardIds].map((c, j) => (
                      <CardChip key={c} cardId={c} size="mini" className={j > 0 ? '-ml-2' : ''} />
                    ))}
                  </div>
                  <button onClick={() => handleRemoveBidSet(i)} className="text-red-300 text-[11px] font-black px-2">
                    Remove
                  </button>
                </div>
              ))}
              <button
                onClick={handleAddBidSet}
                disabled={busy || bidPileTotal !== game.bidValue}
                className="w-full py-2 rounded-full bg-white/12 border border-white/30 text-xs font-black disabled:opacity-40"
              >
                Add Set
              </button>
            </div>
          )}
        </>
      ) : undefined;

    const dock = (
      <>
        {renderHandFan(sortHandForDisplay(handCards), {
          selected: (c) => (isBidder && !floorRevealed ? bidValue != null && captureValue(c) === bidValue : bidAction === 'house' && bidCurCardId === c),
          dim: (c) => (isBidder && !floorRevealed ? captureValue(c) < 9 : bidAction === 'house' ? bidSetsUsedCardIds.includes(c) : false),
          onTap: (c) =>
            isBidder && floorRevealed && bidAction === 'house' && c !== bidCard && !bidSetsUsedCardIds.includes(c)
              ? () => setBidCurCardId(c === bidCurCardId ? null : c)
              : undefined,
        })}
        {isBidder && !floorRevealed && myBiddableValues.length > 0 && (
          <button onClick={() => bidValue != null && handleSubmitBidValue(bidValue)} disabled={busy || bidValue == null} className={goBtn}>
            {busy ? 'LOCKING…' : bidValue != null ? `LOCK IN BID · ${bidValue}` : 'PICK A BID'}
          </button>
        )}
        {isBidder && floorRevealed && (
          <button
            onClick={handleResolveBid}
            disabled={
              busy ||
              !bidAction ||
              (bidAction === 'capture' && bidPileTotal !== game.bidValue) ||
              (bidAction === 'house' && (bidSets.length === 0 || !bidHasHandAnchor))
            }
            className={goBtn}
          >
            SUBMIT
          </button>
        )}
      </>
    );

    return renderShell({ banner, bannerColor: isBidder ? '#d97706' : '#475569', table, tableFooter, dock });
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
  const extraCaptureTotal = sumCardValues(selectedFloorCards) + selectedCaptureHouseIds.reduce((sum, id) => sum + (floor.houses.find((h) => h.id === id)?.value || 0), 0);
  const selParsed = selectedCard ? parseCard(selectedCard) : null;
  const selLabel = selParsed ? `${selParsed.rank}${SUIT_SYMBOL[selParsed.suit]}` : '';
  const clearSelection = () => {
    setSelectedCard(null);
    setActionMode(null);
    setSelectedFloorCards([]);
    setSelectedHouseId(null);
    setSelectedCaptureHouseIds([]);
  };

  const banner = !isMyTurn
    ? `${(turnPlayer?.displayName || '…').toUpperCase()}'S TURN`
    : !selectedCard
    ? 'YOUR TURN · PLAY A CARD'
    : !actionMode
    ? 'CHOOSE: CAPTURE, BUILD OR THROW'
    : 'CHECK IT, THEN CONFIRM';
  const bannerColor = isMyTurn ? TEAM_COLOR[me?.team ?? 0] : '#475569';

  const table = (
    <>
      <div className="flex items-center justify-between">
        <p className={lblCls}>Floor</p>
      </div>
      {game.lastAction?.text && (
        <div className="mx-auto w-fit max-w-full text-center bg-black/45 border border-amber-400/60 text-amber-200 text-[11px] font-extrabold px-3 py-1.5 rounded-2xl">
          {game.lastAction.text}
        </div>
      )}
      {floor.houses.length === 0 && floor.looseCards.length === 0 && <p className={chipHint}>The floor is empty.</p>}
      {floor.houses.length > 0 && (
        <div className="flex flex-wrap gap-3 pt-1">
          {floor.houses.map((h) => {
            // In capture mode, a house whose own value already matches the played card is
            // auto-captured by the server regardless — nothing to tap. Otherwise, only a WEAK
            // house (a single, not-yet-locked set) can be folded into a combined-value
            // capture alongside loose cards (e.g. House·10 + a loose 3, captured by a King) —
            // a strong house is locked to its own value and stays non-interactive here.
            const isAutoIncludedHouse = actionMode === 'capture' && value != null && h.value === value;
            const isCaptureFoldable = actionMode === 'capture' && !isAutoIncludedHouse && h.sets.length === 1;
            if (isAutoIncludedHouse) {
              return <HouseTile key={h.id} house={h} players={game.players} included />;
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
        <div className="flex flex-wrap gap-2 pt-1">
          {floor.looseCards.map((c) => {
            // In capture mode, a loose card whose own value already matches the played card
            // is auto-captured by the server regardless — shown as a fixed "included" card,
            // not a toggle, so there's nothing to tap-and-break by re-selecting it.
            const isAutoIncluded = actionMode === 'capture' && value != null && captureValue(c) === value;
            if (isAutoIncluded) {
              return (
                <div key={c} className="relative">
                  <CardChip cardId={c} picked />
                  <span className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-green-500 text-white flex items-center justify-center shadow">
                    <span className="material-symbols-outlined text-[13px] leading-none">check</span>
                  </span>
                </div>
              );
            }
            return (
              <CardChip
                key={c}
                cardId={c}
                picked={selectedFloorCards.includes(c)}
                onClick={canAct && selectedCard && (actionMode === 'house' || actionMode === 'capture') ? () => toggleFloorCard(setSelectedFloorCards, c) : undefined}
              />
            );
          })}
        </div>
      )}

      {(game.dealHistory || []).length > 0 && (
        <div className="space-y-1.5 pt-2">
          <p className={lblCls}>Deal history</p>
          {game.dealHistory.map((d) => {
            const expanded = expandedDeals.has(d.dealNumber);
            const dealNet = d.teamPoints[0] - d.teamPoints[1];
            return (
              <div key={d.dealNumber} className="bg-black/30 rounded-2xl border border-white/10 overflow-hidden">
                <button onClick={() => toggleDealExpanded(d.dealNumber)} className="w-full p-2 flex items-center gap-2 text-left">
                  <span className="material-symbols-outlined text-[16px] text-white/60 shrink-0">{expanded ? 'expand_less' : 'expand_more'}</span>
                  <span className="text-[10px] font-bold text-white/70 shrink-0">Deal {d.dealNumber}</span>
                  <span className="text-[10px] font-black shrink-0" style={{ color: '#7db4ff' }}>A {d.teamPoints[0]}</span>
                  <span className="text-[10px] font-black shrink-0" style={{ color: '#ff8f8f' }}>B {d.teamPoints[1]}</span>
                  <span className="ml-auto text-right shrink-0">
                    <span className="block text-[10px] font-bold text-white/70">{dealNet === 0 ? 'Tied' : `+${Math.abs(dealNet)} ${TEAM_LABEL[dealNet > 0 ? 0 : 1]}`}</span>
                    <span className="block text-[9px] font-bold text-amber-200">
                      Cum: {d.netScoreAfter === 0 ? 'even' : `${Math.abs(d.netScoreAfter)} ${TEAM_LABEL[d.netScoreAfter > 0 ? 0 : 1]}`}
                    </span>
                  </span>
                </button>
                {expanded && (
                  <div className="px-2 pb-2 space-y-1.5 border-t border-white/10 pt-1.5">
                    {([0, 1] as const).map((t) => {
                      const valueCards = (t === 0 ? d.capturedByTeam.team0 : d.capturedByTeam.team1).filter((c) => cardPoints(c) > 0);
                      return (
                        <div key={t} className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold w-14 shrink-0" style={{ color: t === 0 ? '#7db4ff' : '#ff8f8f' }}>{TEAM_LABEL[t]}</span>
                          <span className="text-[10px] font-black shrink-0">{d.teamPoints[t]} pts</span>
                          <div className="flex gap-1 flex-wrap">
                            {valueCards.length === 0 ? (
                              <span className="text-[10px] text-white/50 italic">no value cards</span>
                            ) : (
                              valueCards.map((c, i) => <CardChip key={`${c}-${i}`} cardId={c} size="mini" />)
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
      )}
    </>
  );

  const tableFooter =
    selectedCard && isMyTurn ? (
      <>
        <div className={segWrap}>
          {availableActions.map((a) => (
            <button
              key={a}
              onClick={() => { setActionMode(a); setSelectedFloorCards([]); setSelectedHouseId(null); setSelectedCaptureHouseIds([]); }}
              className={segBtn(actionMode === a)}
            >
              {a === 'capture' ? 'Capture' : a === 'house' ? 'Build House' : 'Throw'}
            </button>
          ))}
        </div>
        {actionMode === 'capture' && (
          <p className={chipHint}>
            Matching cards and houses are taken automatically. Tap more loose cards (or a single-set house) to sweep them in too. Extra{' '}
            <span className="px-2 py-0.5 rounded-full font-black bg-white/15 text-white">{extraCaptureTotal}</span>
          </p>
        )}
        {actionMode === 'house' && (
          <p className={chipHint}>
            {selectedHouseId ? 'Adding to the selected house. ' : 'Tap loose cards to combine with yours, or none to stake it alone. '}
            {allMatchHouseTarget && selectedFloorCards.length > 0 ? 'Matching cards each form their own set. ' : 'Total '}
            <span className={clsx('px-2 py-0.5 rounded-full font-black', (pileTotal >= 9 && pileTotal <= 13) || selectedHouseId ? 'bg-green-500 text-green-950' : 'bg-white/15 text-white')}>{pileTotal}</span>
            {!selectedHouseId && ' (needs 9–13)'}
          </p>
        )}
        {actionMode === 'throw' && <p className={chipHint}>Drops {selLabel} on the floor as a loose card.</p>}
        {!actionMode && <p className={chipHint}>Playing {selLabel} (value {value}) — pick what to do with it.</p>}
      </>
    ) : undefined;

  const dock = (
    <>
      {renderHandFan(handSorted, {
        selected: (c) => selectedCard === c,
        onTap: (c) => (canAct ? () => setSelectedCard(c === selectedCard ? null : c) : undefined),
      })}
      {selectedCard && isMyTurn ? (
        <div className="flex gap-2">
          <button
            onClick={() => actionMode && handlePlay(actionMode)}
            disabled={busy || !actionMode}
            className={clsx(goBtn, 'flex-1')}
          >
            {!actionMode ? 'CHOOSE AN ACTION' : actionMode === 'capture' ? `CAPTURE WITH ${selLabel}` : actionMode === 'house' ? (selectedHouseId ? `ADD TO HOUSE WITH ${selLabel}` : `BUILD HOUSE WITH ${selLabel}`) : `THROW ${selLabel}`}
          </button>
          <button onClick={clearSelection} className="px-5 rounded-full bg-white/12 border border-white/30 text-sm font-black">Cancel</button>
        </div>
      ) : (
        <p className={chipHint}>{isMyTurn ? 'Tap a card in your hand to play it' : `Waiting for ${turnPlayer?.displayName || '…'}…`}</p>
      )}
    </>
  );

  return renderShell({ banner, bannerColor, table, tableFooter, dock });
}
