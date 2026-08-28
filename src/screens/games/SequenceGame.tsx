import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { doc, updateDoc, collection, query, where } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { useFriendships } from '../../lib/useFriendships';
import { showGamePointsIfAny } from '../../lib/pointsApi';
import Fireworks from '../../components/Fireworks';
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

const CardChip: React.FC<{ cardId: string; selected?: boolean; onClick?: () => void }> = ({ cardId, selected, onClick }) => {
  const { rank, suit } = parseCard(cardId);
  const red = SUIT_RED[suit];
  return (
    <button
      onClick={onClick}
      className={`shrink-0 w-11 h-14 rounded-lg border-2 flex flex-col items-center justify-center font-bold bg-white transition-all ${
        selected ? 'border-primary -translate-y-2 shadow-md' : 'border-border-subtle'
      } ${red ? 'text-error' : 'text-on-surface'}`}
    >
      <span className="text-xs">{rank}</span>
      <span className="text-sm leading-none">{SUIT_SYMBOL[suit]}</span>
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
    border: `3px solid ${color}`,
    background: `${color}22`,
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
        const t = setTimeout(() => setSmallCelebration(null), 2800);
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
          <button onClick={() => navigate('/games/sequence')} className="text-text-muted">
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          </button>
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
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold" style={{ background: SIDE_COLOR[side] }}>
                      {p.displayName?.slice(0, 1) || '?'}
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
  const turnPlayer = game.players[game.currentTurnSeatIndex];
  const needed = sequencesToWin(game.playerCount);
  const winnerText =
    game.winnerSide != null ? `${SIDE_LABEL[game.winnerSide]}${isTeamPlay ? ' team' : ''} wins!` : 'Match ended';
  const winnerNames =
    game.winnerSide != null
      ? game.players.filter((p) => sideForSeat(p.seatIndex, game.playerCount) === game.winnerSide).map((p) => p.displayName).join(' & ')
      : '';

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <ReactionOverlay reactions={floatingReactions} />
      {smallCelebration && (
        <div className="fixed inset-x-0 top-14 z-50 flex justify-center pointer-events-none px-6">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setSmallCelebration(null)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSmallCelebration(null); }}
            className="pointer-events-auto cursor-pointer px-5 py-3 rounded-2xl shadow-2xl text-center animate-bounce max-w-xs"
            style={{ background: SIDE_COLOR[smallCelebration.side], color: 'white' }}
          >
            <p className="text-2xl mb-0.5">✨🔗</p>
            <p className="text-sm font-black leading-snug">{smallCelebration.line}</p>
            <p className="text-[10px] font-bold opacity-80 mt-1">
              {SIDE_LABEL[smallCelebration.side]}{isTeamPlay ? ' team' : ''} lines up a sequence! · tap to dismiss
            </p>
          </div>
        </div>
      )}
      {showBigCelebration && bigCelebrationLine && game.winnerSide != null && (
        <div className="fixed inset-x-0 top-14 z-50 flex justify-center pointer-events-none px-6">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setShowBigCelebration(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setShowBigCelebration(false); }}
            className="pointer-events-auto cursor-pointer px-5 py-3.5 rounded-2xl shadow-2xl text-center animate-bounce max-w-xs border-2 border-white/40"
            style={{ background: SIDE_COLOR[game.winnerSide], color: 'white' }}
          >
            <p className="text-3xl mb-0.5">🎆🎉🎇</p>
            <p className="text-base font-black leading-snug">{winnerText}</p>
            <p className="text-sm font-bold opacity-90">{bigCelebrationLine}</p>
            <p className="text-[10px] font-bold opacity-80 mt-1">tap to dismiss</p>
          </div>
        </div>
      )}
      <header className="p-3 flex items-center gap-2 bg-white border-b border-border-subtle">
        <button onClick={() => navigate('/games/sequence')} className="text-text-muted shrink-0">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
        </button>
        <h1 className="font-black text-primary text-sm shrink-0">Sequence</h1>
        <ReactionButton onSend={handleSendQuickReaction} />
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
          <VoiceChatButton voice={voice} />
          <HelpButton onClick={() => setShowHelp(true)} />
          {isFinished ? (
            <button onClick={() => setShowResultPanel(true)} className="p-2 text-primary" aria-label="Show result">
              <span className="material-symbols-outlined text-[20px] block">emoji_events</span>
            </button>
          ) : (
            <button onClick={handleEndGame} className="p-2 text-error/70" aria-label="End game">
              <span className="material-symbols-outlined text-[20px] block">flag</span>
            </button>
          )}
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

      <main className="flex-1 p-3 max-w-md mx-auto w-full space-y-3 pb-6">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-1.5">
            {Array.from({ length: sideCount(game.playerCount) }, (_, side) => (
              <div key={side} className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: SIDE_COLOR[side] }} />
                <span className="text-[10px] font-bold text-text-muted">
                  {sequenceCountBySide[side] || 0}/{needed}
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs font-bold flex items-center gap-1" style={{ color: isFinished ? SIDE_COLOR[game.winnerSide ?? 0] : isMyTurn ? '#16A34A' : undefined }}>
            {isFinished ? 'Game over' : isMyTurn ? 'Your turn' : `${turnPlayer?.displayName || 'Opponent'}'s turn`}
            {!isFinished && !isMyTurn && turnPlayer?.uid && <PresenceDot uid={turnPlayer.uid} className="w-2 h-2" />}
          </p>
        </div>

        <div className="relative grid grid-cols-10 gap-[1.5px] bg-border-subtle rounded-xl overflow-hidden border-2 border-border-subtle">
          {board.map((chipSide, i) => {
            const cardCode = BOARD_LAYOUT[i];
            const isCorner = CORNER_INDICES.includes(i);
            const isValidTarget = selectedCard != null && validCells.includes(i);
            // Only highlight the opponent's most recent placement — you already know which chip
            // you just placed, so calling it out for your own move is just visual noise.
            const isLastPlaced = game.lastPlacedCell === i && chipSide != null && chipSide !== mySide;
            const parsed = !isCorner ? parseCard(cardCode) : null;
            return (
              <button
                key={i}
                onClick={() => handleCellTap(i)}
                disabled={!isValidTarget}
                className={`relative aspect-square flex items-center justify-center bg-white ${isValidTarget ? 'ring-2 ring-inset ring-success' : ''}`}
              >
                {chipSide != null && (
                  <span
                    className={`absolute inset-[2px] rounded-full ${isLastPlaced ? 'animate-pulse' : ''}`}
                    style={{
                      background: SIDE_COLOR[chipSide],
                      // A gold ring (not either team's own blue/red) so the last-placed chip pops
                      // regardless of which side just played — a plain white halo was too easy to
                      // miss against the board's white cell background.
                      boxShadow: isLastPlaced ? '0 0 0 2px white, 0 0 0 4px #FACC15, 0 0 10px 4px rgba(250,204,21,0.75)' : undefined,
                    }}
                  />
                )}
                {isCorner ? (
                  <span className={`material-symbols-outlined text-[16px] relative z-10 ${chipSide != null ? 'text-white' : 'text-primary/40'}`}>star</span>
                ) : (
                  <span
                    className={`relative z-10 text-[11px] sm:text-xs font-bold leading-none ${
                      chipSide != null ? 'text-white' : parsed && SUIT_RED[parsed.suit] ? 'text-error' : 'text-on-surface'
                    }`}
                  >
                    {parsed?.rank}{parsed ? SUIT_SYMBOL[parsed.suit] : ''}
                  </span>
                )}
              </button>
            );
          })}
          {(game.sequences || []).map((seq, idx) => (
            <div key={idx} style={sequenceOverlayStyle(seq)} />
          ))}
        </div>

        {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

        {!isFinished && selectedCard && (
          <div className="bg-white rounded-2xl border border-border-subtle p-3 space-y-2">
            <p className="text-[11px] text-text-muted">
              {isOneEyedJack(selectedCard)
                ? 'One-eyed jack — tap an opponent chip to remove it.'
                : isTwoEyedJack(selectedCard)
                ? 'Two-eyed jack — wild! Tap any open space.'
                : 'Tap a highlighted space to place your chip.'}
            </p>
            {isDead && (
              <button onClick={handleExchangeDead} disabled={busy} className="w-full py-2.5 bg-warning text-white font-bold rounded-xl text-sm disabled:opacity-50">
                {busy ? 'Exchanging…' : 'Dead Card — Exchange It'}
              </button>
            )}
          </div>
        )}

        {!isFinished && (
          <div>
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1 mb-1">
              Your Hand · {game.cardsRemaining} left in deck
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
              {handSorted.map((c, idx) => (
                // Keyed by value+position, not just value — a two-deck shoe routinely deals
                // duplicate cards into the same hand, and a bare `key={c}` collision between two
                // identical cards causes React to misattribute clicks/DOM nodes between them after
                // a resort (e.g. tapping the first of two 5s could silently act on the second).
                <CardChip key={`${c}-${idx}`} cardId={c} selected={selectedCard === c} onClick={() => handleCardTap(c)} />
              ))}
            </div>
          </div>
        )}
      </main>

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
              <button onClick={() => navigate('/games/sequence')} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">
                Back to Lobby
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
