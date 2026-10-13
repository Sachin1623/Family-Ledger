import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { doc, updateDoc, collection, query, where } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { useFriendships } from '../../lib/useFriendships';
import { showGamePointsIfAny } from '../../lib/pointsApi';
import Fireworks from '../../components/Fireworks';
import ShareWinButton from '../../components/ShareWinButton';
import { buildWinShare } from '../../lib/winShareImage';
import {
  parseCard,
  SUIT_SYMBOL,
  SUIT_RED,
  BOARD_LAYOUT,
  CORNER_INDICES,
  CARD_TO_CELLS,
  sideForSeat,
  sideCount,
  sequencesToWin,
  playerCountDescription,
  SIDE_COLOR,
  SIDE_LABEL,
  isTwoEyedJack,
  isOneEyedJack,
  sortHandForDisplay,
  type SequenceGame as SequenceGameDoc,
  type SequencePlayerCount,
} from '../../lib/sequence';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { SEQUENCE_HELP } from '../../lib/gameHelp';
import { ReactionButton, ReactionOverlay, useReactionOverlay } from '../../components/GameReactions';
import { ChatButton, ChatPanel, useGameChat } from '../../components/GameChat';
import { VoiceChatButton, useGameVoice } from '../../components/GameVoiceChat';
import InvitePicker from '../../components/InvitePicker';
import PresenceDot from '../../components/PresenceDot';
import ShareGameButton from '../../components/ShareGameButton';
import { useGameTurnPresence } from '../../lib/gameTurnPresence';

// Felt-table hand card (absolutely positioned inside the fan).
const CardChip: React.FC<{ cardId: string; selected?: boolean; onClick?: () => void; style?: React.CSSProperties }> = ({ cardId, selected, onClick, style }) => {
  const { rank, suit } = parseCard(cardId);
  const red = SUIT_RED[suit];
  return (
    <button
      onClick={onClick}
      style={style}
      className={`absolute w-14 h-20 rounded-lg bg-white border border-slate-300 flex items-center justify-center font-black transition-all shadow-[0_3px_0_rgba(0,0,0,0.25),0_6px_10px_rgba(0,0,0,0.3)] active:scale-95 ${
        selected ? 'ring-[3px] ring-amber-400 shadow-[0_10px_14px_rgba(0,0,0,0.4)]' : ''
      } ${red ? 'text-red-600' : 'text-slate-900'}`}
    >
      <span className="absolute top-[3px] left-[5px] text-[0.75rem]">{rank}</span>
      <span className="text-[1.7rem] mt-2">{SUIT_SYMBOL[suit]}</span>
    </button>
  );
};

// A single absolutely-positioned capsule (pill shape) spanning all 5 cells of a completed
// sequence — including a corner FREE-star cell, if the line runs through one, since the corner is
// just cells[k] like any other and the geometry below includes it automatically. Positioned in
// percentages of the (square) 10x10 board container: horizontal/vertical sequences get an exact
// bounding-box capsule; diagonals get a capsule the length of the bounding box's own diagonal,
// rotated to match, centered on the bounding box's center — hugging just the 5 cells rather than
// covering the full 5x5 box a plain rectangle would.
function sequenceOverlayStyle(seq: { cells: number[]; side: number }): React.CSSProperties {
  const cells = seq.cells;
  const color = SIDE_COLOR[seq.side];
  const cellPct = 10;
  const rows = cells.map((c) => Math.floor(c / 10));
  const cols = cells.map((c) => c % 10);
  const minR = Math.min(...rows);
  const minC = Math.min(...cols);
  const isHorizontal = new Set(rows).size === 1;
  const isVertical = new Set(cols).size === 1;

  const base: React.CSSProperties = {
    position: 'absolute',
    boxSizing: 'border-box',
    border: '3px solid #FDE047',
    background: `${color}26`,
    boxShadow: '0 0 12px #FDE047aa',
    zIndex: 25,
    borderRadius: 9999,
    pointerEvents: 'none',
  };

  if (isHorizontal) {
    return { ...base, left: `${minC * cellPct}%`, top: `${minR * cellPct}%`, width: `${5 * cellPct}%`, height: `${cellPct}%` };
  }
  if (isVertical) {
    return { ...base, left: `${minC * cellPct}%`, top: `${minR * cellPct}%`, width: `${cellPct}%`, height: `${5 * cellPct}%` };
  }
  // Diagonal — down-right if the last cell's column is greater than the first's, else down-left.
  const goesRight = cols[cols.length - 1] > cols[0];
  return {
    ...base,
    left: `${(minC + 2.5) * cellPct}%`,
    top: `${(minR + 2.5) * cellPct}%`,
    width: `${5 * Math.SQRT2 * cellPct}%`,
    height: `${cellPct * 0.85}%`,
    transform: `translate(-50%, -50%) rotate(${goesRight ? 45 : -45}deg)`,
  };
}

// A mid-match sequence that doesn't yet win the game (e.g. the 1st of 2 needed) — a light, brief,
// auto-dismissing toast so play can carry straight on.
const SMALL_SEQUENCE_LINES = [
  'One line down, one to go!',
  'Ooh, that\'s a tidy little row.',
  'Getting spicy over here.',
  'The board is shaking (a little).',
  'Nicely lined up!',
  'Halfway to bragging rights.',
];

// The winning sequence — a bigger, tap-to-dismiss moment layered in front of the match-end screen.
const BIG_SEQUENCE_LINES = [
  "GAME OVER. Literally. You won!",
  'That board never saw it coming.',
  'Chips down, mic dropped.',
  '5 in a row and feeling like a genius.',
  "That's a wrap — sequence squad wins!",
  'Absolutely lined up for greatness.',
];

export default function SequenceGame() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { friendCandidates } = useFriendships(user?.uid);

  const [gameSnap, loading] = useDocument(gameId ? doc(db, 'sequenceGames', gameId) : null);
  const game = gameSnap?.exists() ? (gameSnap.data() as SequenceGameDoc) : null;
  const voice = useGameVoice('sequenceGames', gameId, game?.players || []);

  // Points are awarded inline, server-side, the moment the game's finish transaction commits —
  // this just triggers every player's OWN flying-coins animation once their client notices the
  // finish (deduped per gameId so a re-render never re-triggers it).
  const shownSequencePointsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!gameId || !user || game?.status !== 'finished') return;
    if (shownSequencePointsRef.current.has(gameId)) return;
    shownSequencePointsRef.current.add(gameId);
    showGamePointsIfAny('sequence', gameId);
  }, [gameId, user, game?.status]);

  // "It's your turn" presence — see notifyGameTurn in server.ts, called from /api/sequence/play.
  useGameTurnPresence('sequence', gameId);

  const floatingReactions = useReactionOverlay(game?.lastReaction);
  const handleSendQuickReaction = async (emoji: string) => {
    if (!user || !gameId) return;
    try {
      const idToken = await user.getIdToken();
      await fetch('/api/games/react', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameType: 'sequence', gameId, emoji }),
      });
    } catch (err) {
      console.error('Failed to send reaction:', err);
    }
  };

  const [handSnap] = useDocument(
    gameId && user && game?.status === 'active' ? doc(db, 'sequenceGames', gameId, 'hands', user.uid) : null,
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
  const [addingBot, setAddingBot] = useState(false);
  const { messages: chatMessages, loading: chatLoading, hasUnseen: chatUnseen, markSeen: markChatSeen } = useGameChat('sequenceGames', gameId);
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

  const [selectedCard, setSelectedCard] = useState<string | null>(null);

  useEffect(() => {
    setSelectedCard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.currentTurnSeatIndex, gameId]);

  // Small celebration — shown to every player the instant ANY side's sequence count grows, as
  // long as it's not yet enough to win (that gets the bigger treatment below instead). Tracked by
  // a snapshot of the counts array via a ref, same pattern as Sweep's sweep celebration.
  const [smallCelebration, setSmallCelebration] = useState<{ side: number; line: string } | null>(null);
  const prevCountsRef = useRef<number[]>([]);
  useEffect(() => {
    if (!game || game.status !== 'active') return;
    const counts = game.sequenceCountBySide || [];
    const prev = prevCountsRef.current;
    const needed = sequencesToWin(game.playerCount);
    for (let side = 0; side < counts.length; side++) {
      if (counts[side] > (prev[side] || 0) && counts[side] < needed) {
        setSmallCelebration({ side, line: SMALL_SEQUENCE_LINES[Math.floor(Math.random() * SMALL_SEQUENCE_LINES.length)] });
        const t = setTimeout(() => setSmallCelebration(null), 3400);
        prevCountsRef.current = counts;
        return () => clearTimeout(t);
      }
    }
    prevCountsRef.current = counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.sequenceCountBySide, game?.status, gameId]);

  // Big celebration — the winning sequence. Same lightweight, non-blocking toast treatment as the
  // small mid-match one (not a full-page takeover — the board stays visible and playable-looking
  // underneath), just with a fireworks flourish and a longer hang time. Guarded to fire only once
  // per game via a ref — GameRouteKey remounts this whole component for a rematch, so a fresh ref
  // for the new game is automatic.
  const [showBigCelebration, setShowBigCelebration] = useState(false);
  const [bigCelebrationLine, setBigCelebrationLine] = useState<string | null>(null);
  const bigShownRef = useRef(false);
  useEffect(() => {
    if (game?.status === 'finished' && game.winnerSide != null && !bigShownRef.current) {
      bigShownRef.current = true;
      setBigCelebrationLine(BIG_SEQUENCE_LINES[Math.floor(Math.random() * BIG_SEQUENCE_LINES.length)]);
      setShowBigCelebration(true);
      const t = setTimeout(() => setShowBigCelebration(false), 4500);
      return () => clearTimeout(t);
    }
  }, [game?.status, game?.winnerSide]);

  // The dismissible match-end result panel — shown once automatically when the game finishes, but
  // closeable so the player can look at the final board; reopenable via the header's trophy button.
  const [showResultPanel, setShowResultPanel] = useState(false);
  const resultShownRef = useRef(false);
  useEffect(() => {
    if (game?.status === 'finished' && !resultShownRef.current) {
      resultShownRef.current = true;
      setShowResultPanel(true);
    }
  }, [game?.status]);

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
  const isHost = user.uid === game.hostUid;
  const mySide = me ? sideForSeat(me.seatIndex, game.playerCount) : -1;
  const isTeamPlay = sideCount(game.playerCount) !== game.playerCount;

  const board: (number | null)[] = game.board || new Array(100).fill(null);
  const lockedCells: number[] = game.lockedCells || [];
  const sequenceCountBySide: number[] = game.sequenceCountBySide || [];

  let validCells: number[] = [];
  let isDead = false;
  if (selectedCard) {
    if (isTwoEyedJack(selectedCard)) {
      validCells = board.map((v, i) => (v === null && !CORNER_INDICES.includes(i) ? i : -1)).filter((i) => i >= 0);
    } else if (isOneEyedJack(selectedCard)) {
      validCells = board.map((v, i) => (v != null && v !== mySide && !lockedCells.includes(i) ? i : -1)).filter((i) => i >= 0);
    } else {
      validCells = (CARD_TO_CELLS[selectedCard] || []).filter((i) => board[i] === null);
    }
    isDead = validCells.length === 0;
  }

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
        handCount: 0,
        isBot: false,
      };
      await updateDoc(doc(db, 'sequenceGames', gameId!), {
        players: [...game.players, newPlayer],
        playerUids: [...game.playerUids, user.uid],
      });
    } catch (err) {
      console.error('Failed to join Sequence game:', err);
      setError('Failed to join — the game may already be full or started.');
    }
  };

  const handleInvite = async (inviteeUids: string[], poke = false) => {
    if (!user || inviteeUids.length === 0) return;
    const idToken = await user.getIdToken();
    await fetch('/api/sequence/invite', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, inviteeUids, poke }),
    }).catch((err) => console.error('sequence invite failed:', err));
    if (!poke) setShowInvite(false);
  };

  const handleStart = async () => {
    await call('/api/sequence/start', {}).catch(() => {});
  };

  const handleFillBot = async () => {
    setAddingBot(true);
    setError(null);
    try {
      await call('/api/sequence/fill-bot', {});
    } catch {
      // error already surfaced via `error` state
    } finally {
      setAddingBot(false);
    }
  };

  const handleCopyCode = () => {
    navigator.clipboard?.writeText(game.code).catch(() => {});
  };

  const handleEndGame = async () => {
    if (!window.confirm("End this game now for everyone? This can't be undone.")) return;
    await call('/api/sequence/end', {}).catch(() => {});
  };

  const handleDeleteGame = async () => {
    if (!window.confirm('Delete this game? This cannot be undone.')) return;
    try {
      await call('/api/sequence/delete', {});
      navigate('/games/sequence');
    } catch {
      // error already surfaced via `error` state
    }
  };

  const handlePlayAgain = async () => {
    try {
      const json = await call('/api/sequence/rematch', {});
      if (json?.gameId) navigate(`/games/sequence/${json.gameId}`);
    } catch {
      // error already surfaced via `error` state
    }
  };

  const handleCardTap = (cardId: string) => {
    if (!isMyTurn || busy) return;
    setSelectedCard((prev) => (prev === cardId ? null : cardId));
  };

  const handleCellTap = async (idx: number) => {
    if (!selectedCard || !validCells.includes(idx)) return;
    const action = isOneEyedJack(selectedCard) ? 'remove' : 'place';
    await call('/api/sequence/play', { cardId: selectedCard, action, cellIndex: idx }).catch(() => {});
    setSelectedCard(null);
  };

  const handleExchangeDead = async () => {
    if (!selectedCard) return;
    await call('/api/sequence/play', { cardId: selectedCard, action: 'dead' }).catch(() => {});
    setSelectedCard(null);
  };

  // ---- Waiting room ----
  if (game.status === 'waiting') {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <ReactionOverlay reactions={floatingReactions} />
        <header className="p-4 flex items-center gap-3 bg-white border-b border-border-subtle">
          <h1 className="font-black text-primary">Sequence</h1>
          <ReactionButton onSend={handleSendQuickReaction} />
          <div className="flex items-center gap-1.5 ml-auto">
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
        </header>
        {showHelp && <GameHelpModal content={SEQUENCE_HELP} onClose={() => setShowHelp(false)} />}
        {showChat && user && (
          <ChatPanel
            collectionName="sequenceGames"
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
                gameLabel="Sequence"
                code={game.code}
                path={`/games/sequence/${gameId}`}
                className="px-3 py-2 bg-[#25D366] text-white rounded-xl text-xs font-bold flex items-center gap-1"
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
            {game.players.map((p) => {
              const side = sideForSeat(p.seatIndex, game.playerCount);
              return (
                <div key={p.uid} className="p-4 flex items-center gap-3">
                  <div className="relative w-9 h-9 shrink-0">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold overflow-hidden" style={{ background: SIDE_COLOR[side] }}>
                      {p.isBot ? '🤖' : p.photoURL ? (
                        <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      ) : (
                        p.displayName?.slice(0, 1) || '?'
                      )}
                    </div>
                    <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-3 h-3" />
                  </div>
                  <p className="text-sm font-bold text-on-surface">{p.displayName}</p>
                  {isTeamPlay && <span className="text-[10px] font-bold uppercase" style={{ color: SIDE_COLOR[side] }}>{SIDE_LABEL[side]} team</span>}
                  {p.uid === game.hostUid && <span className="ml-auto text-[10px] font-bold text-primary uppercase">Host</span>}
                </div>
              );
            })}
            {Array.from({ length: Math.max(0, game.playerCount - game.players.length) }).map((_, i) => (
              <div key={i} className="p-4 flex items-center gap-3 opacity-40">
                <div className="w-9 h-9 rounded-full border-2 border-dashed border-border-subtle" />
                <p className="text-sm text-text-muted italic">Waiting for player…</p>
              </div>
            ))}
          </div>

          <p className="text-xs text-text-muted px-1">{playerCountDescription(game.playerCount)}</p>

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

          {isPlayer && isHost && game.players.length < game.playerCount && (
            <button
              onClick={handleFillBot}
              disabled={addingBot}
              className="w-full py-2.5 border border-border-subtle text-primary font-bold rounded-xl text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">smart_toy</span>
              {addingBot ? 'Adding…' : 'Fill Empty Seat with Bot'}
            </button>
          )}

          {isPlayer && isHost ? (
            <button
              onClick={handleStart}
              disabled={busy || game.players.length < game.playerCount}
              className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
            >
              {game.players.length < game.playerCount ? `Need ${game.playerCount} players` : busy ? 'Starting…' : 'Start Game'}
            </button>
          ) : isPlayer ? (
            <p className="text-center text-sm text-text-muted italic">Waiting for the host to start the game…</p>
          ) : null}

          {isHost && (
            <button onClick={handleDeleteGame} className="w-full py-2.5 text-error/70 font-bold text-sm">
              Delete Game
            </button>
          )}
        </main>
      </div>
    );
  }

  // ---- Active / Finished (the board stays visible and viewable after the game ends — only the
  // result panel below is dismissible/reopenable, not the whole screen) ----
  const isFinished = game.status === 'finished';
  // Legal-move glow: your own team colour for placing, red when a one-eyed jack removes an opponent's chip.
  const hintColor = selectedCard && isOneEyedJack(selectedCard) ? '#EF4444' : SIDE_COLOR[mySide] || '#2563EB';
  const turnPlayer = game.players[game.currentTurnSeatIndex];
  const needed = sequencesToWin(game.playerCount);
  const winnerText =
    game.winnerSide != null ? `${SIDE_LABEL[game.winnerSide]}${isTeamPlay ? ' team' : ''} wins!` : 'Match ended';
  const winnerNames =
    game.winnerSide != null
      ? game.players.filter((p) => sideForSeat(p.seatIndex, game.playerCount) === game.winnerSide).map((p) => p.displayName).join(' & ')
      : '';
  const winShare = isFinished && me && game.winnerSide != null && sideForSeat(me.seatIndex, game.playerCount) === game.winnerSide
    ? buildWinShare({
        gameName: 'Sequence',
        hero: { kind: 'sequence' as const, board: game.board || [], sequences: game.sequences || [], winnerSide: game.winnerSide, needed },
        winnerLabel: winnerNames,
        standings: Array.from(new Set(game.players.map((p) => sideForSeat(p.seatIndex, game.playerCount))))
          .sort((a, b) => Number(b === game.winnerSide) - Number(a === game.winnerSide))
          .map((side) => ({
            name: game.players.filter((p) => sideForSeat(p.seatIndex, game.playerCount) === side).map((p) => p.displayName).join(' & '),
            label: side === game.winnerSide ? `${needed} sequences` : undefined,
            isWinner: side === game.winnerSide,
          })),
        detail: isTeamPlay ? 'Team game' : `${game.playerCount}-player game`,
      })
    : null;

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <ReactionOverlay reactions={floatingReactions} />
      {(() => {
        const win = showBigCelebration && bigCelebrationLine && game.winnerSide != null;
        const small = !win && smallCelebration;
        if (!win && !small) return null;
        const side = win ? game.winnerSide! : smallCelebration!.side;
        const tc = SIDE_COLOR[side];
        const dismiss = () => { setShowBigCelebration(false); setSmallCelebration(null); };
        const n = win ? 40 : 26;
        const confetti = Array.from({ length: n }).map((_, i) => {
          const ang = (i / n) * Math.PI * 2 + (i % 3) * 0.2;
          const dist = (win ? 130 : 100) + ((i * 37) % 90);
          return { dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist, color: ['#fbbf24', '#f87171', '#60a5fa', '#4ade80', '#fff', '#c084fc'][i % 6], delay: (i % 7) * 0.04, rot: (i * 57) % 360 };
        });
        const seqCount = sequenceCountBySide[side] || 0;
        return (
          <div
            role="button"
            tabIndex={0}
            onClick={dismiss}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') dismiss(); }}
            className="fixed inset-0 z-[230] flex items-center justify-center cursor-pointer overflow-hidden"
            style={{ background: `radial-gradient(circle at 50% 45%, ${tc}66, rgba(0,0,0,0.8) 70%)`, animation: 'seqFade 0.25s ease-out' }}
          >
            <style>{`
              @keyframes seqFade{from{opacity:0}to{opacity:1}}
              @keyframes seqPop{0%{transform:scale(.2) rotate(-8deg);opacity:0}55%{transform:scale(1.25) rotate(3deg);opacity:1}100%{transform:scale(1) rotate(-2deg)}}
              @keyframes seqChip{0%{transform:translateY(-40px) scale(.2);opacity:0}70%{transform:translateY(4px) scale(1.15);opacity:1}100%{transform:translateY(0) scale(1);opacity:1}}
              @keyframes seqGlow{0%,100%{box-shadow:0 0 0 2px #fde047,0 0 14px #fde047}50%{box-shadow:0 0 0 2px #fde047,0 0 30px #fde047}}
              @keyframes seqBurst{0%{transform:translate(0,0) rotate(0) scale(.4);opacity:1}100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(1);opacity:0}}
              @keyframes seqRise{0%{transform:translateY(16px);opacity:0}100%{transform:translateY(0);opacity:1}}
              @keyframes seqTrophy{0%{transform:translateY(30px) scale(.3);opacity:0}60%{transform:translateY(-8px) scale(1.2);opacity:1}100%{transform:translateY(0) scale(1)}}
            `}</style>
            <div className="absolute left-1/2 top-[44%]">
              {confetti.map((c, i) => (
                <i
                  key={i}
                  className="absolute block w-2 h-3 rounded-[2px]"
                  style={{ background: c.color, ['--dx' as any]: `${c.dx}px`, ['--dy' as any]: `${c.dy}px`, ['--rot' as any]: `${c.rot}deg`, animation: `seqBurst 1.3s ease-out ${0.7 + c.delay}s both` }}
                />
              ))}
            </div>
            <div className="relative text-center px-6 flex flex-col items-center">
              {win && <span className="text-[4.5rem] leading-none" style={{ animation: 'seqTrophy 0.7s cubic-bezier(.2,1.3,.4,1) 0.1s both' }}>🏆</span>}
              {/* five chips snap into a row — the sequence */}
              <div className="flex gap-1.5 mb-3">
                {[0, 1, 2, 3, 4].map((k) => (
                  <span
                    key={k}
                    className="w-10 h-10 rounded-full border-[5px]"
                    style={{ borderColor: tc, background: `${tc}55`, animation: `seqChip 0.35s cubic-bezier(.3,1.4,.5,1) ${0.1 + k * 0.1}s both, seqGlow 1.2s ease-in-out ${0.7}s infinite` }}
                  />
                ))}
              </div>
              <p
                className="text-[3.4rem] leading-none font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-amber-100 via-amber-300 to-amber-600 drop-shadow-[0_6px_0_rgba(0,0,0,0.45)]"
                style={{ filter: `drop-shadow(0 0 22px ${tc})`, animation: 'seqPop 0.6s cubic-bezier(.2,1.3,.4,1) 0.65s both' }}
              >
                {win ? 'WINNER!' : 'SEQUENCE!'}
              </p>
              <p className="mt-3 text-sm font-extrabold text-white max-w-[16rem] leading-snug" style={{ animation: 'seqRise 0.4s ease-out 1.1s both' }}>
                {win ? bigCelebrationLine : smallCelebration!.line}
              </p>
              <p className="mt-3 inline-block px-4 py-1.5 rounded-full text-xs font-black text-white shadow-lg" style={{ background: tc, animation: 'seqRise 0.4s ease-out 1.25s both' }}>
                {win ? winnerText : `${SIDE_LABEL[side]}${isTeamPlay ? ' team' : ''} · ${seqCount} of ${needed} sequences`}
              </p>
            </div>
          </div>
        );
      })()}
      {showHelp && <GameHelpModal content={SEQUENCE_HELP} onClose={() => setShowHelp(false)} />}
      {showChat && user && (
        <ChatPanel
          collectionName="sequenceGames"
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

      {/* Full-screen table (covers the app header and tab bar): header, player pills, a turn banner,
          the wooden board, and your hand in a dock underneath. */}
      <div className="fixed inset-0 z-[150] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white bg-[radial-gradient(ellipse_at_50%_30%,#2a2147_0%,#161233_55%,#0a0820_100%)]">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40 [background-image:radial-gradient(rgba(255,255,255,0.14)_1px,transparent_1.5px)] [background-size:24px_24px]" />

        <header className="relative shrink-0 flex items-center gap-2 px-3 pt-2">
          <button onClick={() => navigate('/games/sequence')} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center" aria-label="Back">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <div className="leading-tight">
            <h1 className="text-[15px] font-black">Sequence</h1>
            <span className="text-[8px] font-bold tracking-[0.14em] text-white/60">
              {isTeamPlay ? `${sideCount(game.playerCount)} TEAMS` : `${game.playerCount} PLAYERS`} · FIRST TO {needed}
            </span>
          </div>
          <ReactionButton onSend={handleSendQuickReaction} />
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
            <HelpButton onClick={() => setShowHelp(true)} className="!text-white" />
            {isFinished ? (
              <button onClick={() => setShowResultPanel(true)} className="p-1.5 text-amber-300 shrink-0" aria-label="Show result">
                <span className="material-symbols-outlined text-[22px] block">emoji_events</span>
              </button>
            ) : (
              <button onClick={handleEndGame} className="p-1.5 text-red-300 shrink-0" aria-label="End game">
                <span className="material-symbols-outlined text-[22px] block">flag</span>
              </button>
            )}
          </div>
        </header>

        {/* player pills — each shows its side's colour and sequence trophies */}
        <div className="relative shrink-0 flex flex-wrap items-center justify-center gap-1.5 px-3 pt-2">
          {game.players.map((p, i) => {
            const side = sideForSeat(p.seatIndex, game.playerCount);
            const color = SIDE_COLOR[side];
            const active = !isFinished && i === game.currentTurnSeatIndex;
            const compact = game.players.length > 4;
            return (
              <div
                key={p.uid}
                className={`flex items-center gap-2 rounded-full p-1 pr-3 border-2 backdrop-blur-sm ${compact ? 'h-9' : 'h-[3.1rem]'} ${
                  !compact ? (game.players.length > 2 ? 'w-[calc(50%-0.2rem)]' : 'min-w-[9.5rem]') : ''
                } ${active ? 'bg-black/55' : 'bg-black/35 border-white/15'}`}
                style={active ? { borderColor: color, boxShadow: `0 0 0 2px #fff, 0 0 16px ${color}` } : undefined}
              >
                <div className={`relative shrink-0 rounded-full flex items-center justify-center font-black bg-slate-700 ${compact ? 'w-6 h-6 text-[10px]' : 'w-9 h-9 text-sm'}`} style={{ border: `3px solid ${color}` }}>
                  <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center">
                    {p.isBot ? <span className="text-sm leading-none">🤖</span> : p.photoURL ? <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : p.displayName?.slice(0, 1) || '?'}
                  </div>
                  <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2 h-2" />
                </div>
                <div className="min-w-0 leading-tight">
                  <p className={`font-extrabold truncate ${compact ? 'text-[10px] max-w-[4.5rem]' : 'text-[11px]'}`}>{p.uid === user.uid ? 'You' : p.displayName}</p>
                  {!compact && (
                    <div className="flex items-center gap-1 mt-0.5">
                      {Array.from({ length: needed }).map((_, k) => (
                        <i key={k} className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-[8px] not-italic font-black ${k < (sequenceCountBySide[side] || 0) ? 'bg-gradient-to-b from-amber-200 to-amber-600 text-amber-950' : 'bg-white/20 text-white/60'}`}>
                          {k < (sequenceCountBySide[side] || 0) ? '★' : k + 1}
                        </i>
                      ))}
                      <span className="text-[9px] font-bold text-white/60 ml-0.5">{SIDE_LABEL[side]}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* many-player games: one trophy strip per side instead of per-player trophies */}
        {game.players.length > 4 && (
          <div className="relative shrink-0 flex justify-center gap-3 pt-1.5">
            {Array.from({ length: sideCount(game.playerCount) }, (_, side) => (
              <div key={side} className="flex items-center gap-1 text-[10px] font-black">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: SIDE_COLOR[side] }} />
                <span className="text-white/80">{SIDE_LABEL[side]} {sequenceCountBySide[side] || 0}/{needed}</span>
              </div>
            ))}
          </div>
        )}

        {/* turn banner */}
        <div className="relative shrink-0 flex justify-center pt-2">
          {(() => {
            const bannerColor = isFinished ? SIDE_COLOR[game.winnerSide ?? 0] : isMyTurn ? SIDE_COLOR[mySide] || '#2563eb' : '#475569';
            return (
              <span className="px-4 py-1 rounded-full text-[11px] font-black tracking-wide" style={{ background: bannerColor, boxShadow: `0 0 18px ${bannerColor}99` }}>
                {isFinished ? 'GAME OVER' : isMyTurn ? (selectedCard ? 'TAP A GLOWING SPACE' : 'YOUR TURN · PLAY A CARD') : `${(turnPlayer?.displayName || 'OPPONENT').toUpperCase()}'S TURN`}
              </span>
            );
          })()}
        </div>

        {/* the board — scrolls on very short screens so the hand dock never gets squeezed out */}
        <div className="relative flex-1 min-h-0 overflow-y-auto px-3 pt-2.5 pb-1">
          <div className="mx-auto w-full max-w-[26rem] p-[7px] rounded-2xl bg-gradient-to-br from-[#92602d] to-[#5a3a18] shadow-[0_14px_30px_rgba(0,0,0,0.55),inset_0_2px_0_rgba(255,255,255,0.3)]">
            <div className="relative grid grid-cols-10 gap-[1.5px] bg-[#2b1b0a] rounded-lg overflow-hidden">
              {board.map((chipSide, i) => {
                const cardCode = BOARD_LAYOUT[i];
                const isCorner = CORNER_INDICES.includes(i);
                const isValidTarget = selectedCard != null && validCells.includes(i);
                // Only highlight the opponent's most recent placement — you already know which chip
                // you just placed, so calling it out for your own move is just visual noise.
                const isLastPlaced = game.lastPlacedCell === i && chipSide != null && chipSide !== mySide;
                const parsed = !isCorner ? parseCard(cardCode) : null;
                const red = !!parsed && SUIT_RED[parsed.suit];
                const hint = hintColor;
                return (
                  <button
                    key={i}
                    onClick={() => handleCellTap(i)}
                    disabled={!isValidTarget}
                    className={`relative aspect-square flex items-center justify-center ${
                      isCorner ? 'bg-[radial-gradient(circle,#fde68a,#d97706)]' : red ? 'bg-gradient-to-b from-[#fff7f5] to-[#fbe4de]' : 'bg-gradient-to-b from-[#fffdf6] to-[#efe8d4]'
                    } ${isValidTarget ? 'z-[2] animate-pulse' : ''}`}
                    style={isValidTarget ? { boxShadow: `inset 0 0 0 3px ${hint}, 0 0 12px ${hint}` } : undefined}
                  >
                    {isValidTarget && <span className="absolute inset-0" style={{ background: `${hint}40` }} />}
                    {isCorner ? (
                      <span className="material-symbols-outlined text-[20px] relative z-10 text-orange-900" style={{ fontVariationSettings: "'FILL' 1" }}>star</span>
                    ) : (
                      <span className={`relative z-10 font-black leading-none ${red ? 'text-red-600' : 'text-slate-900'}`} style={{ fontSize: 'min(3vw, 12px)' }}>
                        {parsed?.rank}{parsed ? SUIT_SYMBOL[parsed.suit] : ''}
                      </span>
                    )}
                    {/* The chip is a thick ring, hollow in the middle, so the card underneath stays readable. */}
                    {chipSide != null && (
                      <span
                        className={`absolute inset-[1px] z-20 rounded-full pointer-events-none ${isLastPlaced ? 'animate-pulse' : ''}`}
                        style={{
                          border: `4px solid ${SIDE_COLOR[chipSide]}`,
                          background: `${SIDE_COLOR[chipSide]}33`,
                          boxShadow: isLastPlaced
                            ? '0 0 0 2px #fff, 0 0 0 4px #FACC15, 0 0 10px 4px rgba(250,204,21,0.75), 0 3px 5px rgba(0,0,0,0.4)'
                            : 'inset 0 1px 2px rgba(255,255,255,0.5), inset 0 -2px 3px rgba(0,0,0,0.3), 0 3px 5px rgba(0,0,0,0.4)',
                        }}
                      />
                    )}
                  </button>
                );
              })}
              {(game.sequences || []).map((seq, idx) => (
                <div key={idx} style={sequenceOverlayStyle(seq)} />
              ))}
            </div>
          </div>

          <div className="flex justify-center gap-4 mt-2 text-[10px] font-extrabold text-white/75">
            <span><b className="text-amber-200">✦</b> Two-eyed J = wild</span>
            <span><b className="text-red-300">✖</b> One-eyed J = remove a chip</span>
          </div>

          {!isFinished && selectedCard && (
            <p className="mt-2 mx-auto max-w-[26rem] text-center bg-black/45 border text-white text-[11px] font-extrabold px-3 py-1.5 rounded-2xl" style={{ borderColor: hintColor }}>
              {isOneEyedJack(selectedCard)
                ? 'One-eyed jack — tap an opponent chip to remove it.'
                : isTwoEyedJack(selectedCard)
                ? 'Two-eyed jack — wild! Tap any open space.'
                : isDead
                ? 'This card has no open space left — it is dead.'
                : `${parseCard(selectedCard).rank}${SUIT_SYMBOL[parseCard(selectedCard).suit]} can go on ${validCells.length === 1 ? 'one space' : 'two spaces'} — tap a glowing one.`}
            </p>
          )}
        </div>

        {/* dock: your hand, deck count and the dead-card button */}
        {!isFinished && (
          <div className="relative shrink-0 px-3 pb-3 space-y-1.5">
            {error && <p className="text-xs font-bold text-red-300 text-center">{error}</p>}
            {(() => {
              const cardW = 56;
              const avail = Math.min(typeof window !== 'undefined' ? window.innerWidth : 400, 448) - 32;
              const step = handSorted.length > 1 ? Math.min(cardW + 6, (avail - cardW) / (handSorted.length - 1)) : 0;
              return (
                <div className="relative mx-auto h-[6.2rem]" style={{ width: step * Math.max(0, handSorted.length - 1) + cardW }}>
                  {handSorted.map((c, idx) => {
                    const sel = selectedCard === c;
                    return (
                      // Keyed by value+position, not just value — a two-deck shoe routinely deals
                      // duplicate cards into the same hand, and a bare `key={c}` collision between two
                      // identical cards causes React to misattribute clicks/DOM nodes between them after
                      // a resort (e.g. tapping the first of two 5s could silently act on the second).
                      <CardChip key={`${c}-${idx}`} cardId={c} selected={sel} onClick={() => handleCardTap(c)} style={{ left: idx * step, top: sel ? 2 : 16, zIndex: sel ? 50 : idx }} />
                    );
                  })}
                </div>
              );
            })()}
            <div className="flex items-center gap-2">
              <span className="shrink-0 px-4 py-3 rounded-full bg-black/40 border border-white/18 text-[11px] font-extrabold text-white/80 whitespace-nowrap">🂠 {game.cardsRemaining} in deck</span>
              {selectedCard && isDead ? (
                <button
                  onClick={handleExchangeDead}
                  disabled={busy}
                  className="flex-1 py-3 rounded-full text-sm font-black tracking-wide bg-gradient-to-b from-amber-300 to-amber-600 text-amber-950 shadow-[0_5px_0_#92400e,0_9px_16px_rgba(0,0,0,0.4)] active:translate-y-[3px] disabled:opacity-50"
                >
                  {busy ? 'EXCHANGING…' : 'DEAD CARD — EXCHANGE IT'}
                </button>
              ) : (
                <div className="flex-1 py-3 rounded-full text-center text-[13px] font-black tracking-wide bg-white/10 border border-white/20 text-white/75">
                  {!isMyTurn ? 'WAITING FOR YOUR TURN' : selectedCard ? 'TAP A GLOWING SPACE' : 'SELECT A CARD'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Result panel — dismissible (X, backdrop tap) rather than a full-screen takeover, so the
          player can close it to look at the final board; reopenable via the header trophy button. */}
      {isFinished && showResultPanel && (
        <div className="fixed inset-0 z-[280] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowResultPanel(false)} />
          <div className="relative w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 space-y-4 text-center overflow-hidden">
            <Fireworks />
            <button
              onClick={() => setShowResultPanel(false)}
              className="absolute top-3 right-3 p-1.5 text-text-muted hover:bg-surface rounded-full z-10"
              aria-label="Close"
            >
              <span className="material-symbols-outlined text-[20px] block">close</span>
            </button>
            <span className="relative material-symbols-outlined text-5xl text-primary">emoji_events</span>
            <h1 className="relative text-xl font-black text-primary">{winnerText}</h1>
            {winnerNames && <p className="text-sm text-text-muted">{winnerNames}</p>}
            {error && <p className="text-xs font-bold text-error">{error}</p>}
            {winShare && <ShareWinButton card={winShare.card} caption={winShare.caption} />}
            <div className="flex flex-col gap-2 pt-1">
              {isPlayer && (
                <button
                  onClick={() => (game.rematchGameId ? navigate(`/games/sequence/${game.rematchGameId}`) : handlePlayAgain())}
                  disabled={busy}
                  className="w-full py-3 bg-success text-white font-bold rounded-2xl disabled:opacity-50"
                >
                  {game.rematchGameId ? 'Join Rematch' : busy ? 'Starting…' : 'Play Again (Same Players)'}
                </button>
              )}
              <button onClick={() => navigate('/tools?category=games')} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">
                Back to Games
              </button>
              {isHost && (
                <button onClick={handleDeleteGame} className="text-error/70 font-bold text-sm pt-1">
                  Delete Game
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
