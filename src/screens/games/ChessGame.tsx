import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { doc, updateDoc, collection, query, where } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { Chess, type Square, type PieceSymbol, type Move } from 'chess.js';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { useFriendships } from '../../lib/useFriendships';
import {
  PIECE_GLYPH,
  COLOR_LABEL,
  orientedBoard,
  capturedByColor,
  materialEdge,
  describeMove,
  type PlayerColor,
  type ChessGame as ChessGameDoc,
} from '../../lib/chess';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { CHESS_HELP } from '../../lib/gameHelp';
import { ReactionButton, ReactionOverlay, useReactionOverlay } from '../../components/GameReactions';
import { ChatButton, ChatPanel, useGameChat } from '../../components/GameChat';
import { VoiceChatButton, useGameVoice } from '../../components/GameVoiceChat';
import InvitePicker from '../../components/InvitePicker';
import PresenceDot from '../../components/PresenceDot';
import ShareGameButton from '../../components/ShareGameButton';
import Fireworks from '../../components/Fireworks';
import ShareWinButton from '../../components/ShareWinButton';
import { buildWinShare } from '../../lib/winShareImage';
import { useGameTurnPresence, notifyGameTurnClient } from '../../lib/gameTurnPresence';

const LIGHT_SQUARE = '#DFE6F3';
const DARK_SQUARE = '#6F86B3';

const CHECKMATE_LINES = [
  'The king has nowhere left to run.',
  'A clean finish. Take a bow.',
  'Checkmate — the board is yours.',
  'Every move led to this one.',
  'No escape. No defence. Game over.',
];

const PROMOTION_CHOICES: { type: PieceSymbol; label: string }[] = [
  { type: 'q', label: 'Queen' },
  { type: 'r', label: 'Rook' },
  { type: 'b', label: 'Bishop' },
  { type: 'n', label: 'Knight' },
];

// Both colors render the same solid-silhouette glyph shape (see PIECE_GLYPH's comment) — white
// needs an actual fill + outline, not just a light color, or it vanishes on a light square. The
// 8-direction 1px shadow simulates a stroke and renders consistently across browsers, unlike the
// `-webkit-text-stroke` trick this replaced (which is what made white pieces look like a bare
// outline with no fill at all).
function pieceStyle(color: PlayerColor): React.CSSProperties {
  if (color === 'w') {
    return {
      color: '#ffffff',
      textShadow: '1px 0 0 #000, -1px 0 0 #000, 0 1px 0 #000, 0 -1px 0 #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000',
    };
  }
  return { color: '#111111' };
}

export default function ChessGame() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { friendCandidates } = useFriendships(user?.uid);

  const [gameSnap, loading] = useDocument(gameId ? doc(db, 'chessGames', gameId) : null);
  const game = gameSnap?.exists() ? (gameSnap.data() as ChessGameDoc & { id?: string }) : null;

  // "It's your turn" presence — Chess is client-authoritative, so the notify call happens
  // client-side too, right after commitMove's updateDoc below.
  useGameTurnPresence('chess', gameId);

  const floatingReactions = useReactionOverlay(game?.lastReaction);
  const handleSendReaction = async (emoji: string) => {
    if (!user || !gameId) return;
    try {
      const idToken = await user.getIdToken();
      await fetch('/api/games/react', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameType: 'chess', gameId, emoji }),
      });
    } catch (err) {
      console.error('Failed to send reaction:', err);
    }
  };

  const { messages: chatMessages, loading: chatLoading, hasUnseen: chatUnseen, markSeen: markChatSeen } = useGameChat('chessGames', gameId);
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

  const [groupsMembersValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = groupsMembersValue?.docs.map((d) => d.data().groupId) || [];
  const [showInvite, setShowInvite] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [promotionPending, setPromotionPending] = useState<{ from: Square; to: Square } | null>(null);

  const players = game?.players || [];
  const voice = useGameVoice('chessGames', gameId, players);
  const myPlayer = players.find((p) => p.uid === user?.uid);
  const isPlayer = !!myPlayer;
  const myColor: PlayerColor = myPlayer?.color || 'w';

  const chess = useMemo(() => {
    try {
      return new Chess(game?.fen);
    } catch {
      return new Chess();
    }
  }, [game?.fen]);

  const isMyTurn = game?.status === 'active' && isPlayer && chess.turn() === myColor;
  const inCheck = chess.inCheck();
  const board = orientedBoard(chess, myColor);
  const captured = capturedByColor(chess);
  const edge = materialEdge(captured);

  const legalMoves: Move[] = useMemo(() => {
    if (!selectedSquare) return [];
    return chess.moves({ square: selectedSquare, verbose: true });
  }, [chess, selectedSquare]);

  // Celebration → post-game screen. A game that was already finished when opened goes straight to the
  // post-game screen; only a game that ENDS while this screen is open gets the full-screen celebration.
  const [showCelebration, setShowCelebration] = useState(false);
  const [showResultPanel, setShowResultPanel] = useState(false);
  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const st = game?.status;
    if (!st) return;
    const prev = prevStatusRef.current;
    prevStatusRef.current = st;
    if (st !== 'finished' || prev === 'finished') return;
    if (prev === undefined) {
      setShowResultPanel(true);
      return;
    }
    if (game?.result && game.resultReason !== 'ended_early') {
      setShowCelebration(true);
      const t = setTimeout(() => {
        setShowCelebration(false);
        setShowResultPanel(true);
      }, 4200);
      return () => clearTimeout(t);
    }
    setShowResultPanel(true);
  }, [game?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const dismissCelebration = () => {
    setShowCelebration(false);
    setShowResultPanel(true);
  };

  // Keep the newest move in view in the move strip.
  const movesRef = useRef<HTMLDivElement>(null);
  const moveCount = game?.history?.length || 0;
  useEffect(() => {
    if (movesRef.current) movesRef.current.scrollLeft = movesRef.current.scrollWidth;
  }, [moveCount]);

  if (loading) return <div className="p-8 text-center text-sm text-text-muted">Loading…</div>;
  if (!game) return <div className="p-8 text-center text-sm text-text-muted">Game not found.</div>;

  const gameRef = () => doc(db, 'chessGames', gameId!);

  const handleJoin = async () => {
    if (!user || isPlayer || players.length >= 2) return;
    setError(null);
    try {
      const newPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        color: 'b' as PlayerColor,
      };
      await updateDoc(gameRef(), {
        players: [...players, newPlayer],
        playerUids: [...players.map((p) => p.uid), user.uid],
        status: 'active',
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Failed to join game:', err);
      setError('Failed to join — the game may already be full or started.');
    }
  };

  const handleInvite = async (inviteeUids: string[], poke = false) => {
    if (!user || inviteeUids.length === 0) return;
    const idToken = await user.getIdToken();
    await fetch('/api/chess/invite', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, inviteeUids, poke }),
    }).catch((err) => console.error('chess invite failed:', err));
    if (!poke) setShowInvite(false);
  };

  const handleCopyCode = () => {
    navigator.clipboard?.writeText(game.code).catch(() => {});
  };

  const handleDeleteGame = async () => {
    if (!user) return;
    if (!window.confirm('Delete this game? This cannot be undone.')) return;
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/chess/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete game.');
      navigate('/games/chess');
    } catch (err: any) {
      console.error('Failed to delete Chess game:', err);
      setError(err.message || 'Failed to delete game.');
    }
  };

  const commitMove = async (from: Square, to: Square, promotion?: PieceSymbol) => {
    try {
      const next = new Chess(game.fen);
      const move = next.move({ from, to, promotion });
      const moverName = myPlayer?.displayName || 'Someone';

      let status: ChessGameDoc['status'] = 'active';
      let result: ChessGameDoc['result'] = null;
      let resultReason: ChessGameDoc['resultReason'] = null;
      if (next.isCheckmate()) {
        status = 'finished';
        result = move.color;
        resultReason = 'checkmate';
      } else if (next.isStalemate()) {
        status = 'finished';
        result = 'draw';
        resultReason = 'stalemate';
      } else if (next.isThreefoldRepetition()) {
        status = 'finished';
        result = 'draw';
        resultReason = 'threefold_repetition';
      } else if (next.isDrawByFiftyMoves()) {
        status = 'finished';
        result = 'draw';
        resultReason = 'fifty_move_rule';
      } else if (next.isInsufficientMaterial()) {
        status = 'finished';
        result = 'draw';
        resultReason = 'insufficient_material';
      }

      await updateDoc(gameRef(), {
        fen: next.fen(),
        history: [...(game.history || []), move.san],
        lastMove: { from, to, san: move.san },
        status,
        result,
        resultReason,
        drawOfferBy: null,
        finishedAt: status === 'finished' ? new Date().toISOString() : null,
        lastAction: { text: describeMove(next, move.san, moverName), at: new Date().toISOString() },
      });
      if (status !== 'finished') {
        const opponent = players.find((p) => p.uid !== user?.uid);
        if (opponent) {
          notifyGameTurnClient(user, {
            gameType: 'chess',
            gameId: gameId!,
            nextPlayerUid: opponent.uid,
            opponentNames: moverName,
          });
        }
      }
    } catch (err) {
      console.error('Failed to make move:', err);
      setError('That move failed — please try again.');
    } finally {
      setSelectedSquare(null);
      setPromotionPending(null);
    }
  };

  const handleSquareTap = (square: Square) => {
    if (!isMyTurn || busy) return;
    const piece = chess.get(square);

    if (selectedSquare) {
      const target = legalMoves.find((m) => m.to === square);
      if (target) {
        if (target.promotion) {
          setPromotionPending({ from: selectedSquare, to: square });
        } else {
          commitMove(selectedSquare, square);
        }
        return;
      }
      if (piece && piece.color === myColor) {
        setSelectedSquare(square);
        return;
      }
      setSelectedSquare(null);
      return;
    }

    if (piece && piece.color === myColor) setSelectedSquare(square);
  };

  const handleResign = async () => {
    if (!isPlayer || game.status !== 'active') return;
    if (!window.confirm("Resign this game? You'll lose.")) return;
    setBusy(true);
    try {
      const winner = myColor === 'w' ? 'b' : 'w';
      await updateDoc(gameRef(), {
        status: 'finished',
        result: winner,
        resultReason: 'resignation',
        finishedAt: new Date().toISOString(),
        lastAction: { text: `${myPlayer?.displayName || 'A player'} resigned.`, at: new Date().toISOString() },
      });
    } finally {
      setBusy(false);
    }
  };

  const handleOfferDraw = async () => {
    if (!isPlayer || game.status !== 'active') return;
    await updateDoc(gameRef(), { drawOfferBy: user!.uid }).catch(() => {});
  };

  const handleRespondDraw = async (accept: boolean) => {
    if (!isPlayer) return;
    if (accept) {
      await updateDoc(gameRef(), {
        status: 'finished',
        result: 'draw',
        resultReason: 'draw_agreed',
        drawOfferBy: null,
        finishedAt: new Date().toISOString(),
      }).catch(() => {});
    } else {
      await updateDoc(gameRef(), { drawOfferBy: null }).catch(() => {});
    }
  };

  // Mirrors Ludo/Business's End Game — any active player can force the match to finish early for
  // everyone (no result declared), a direct client write since Chess's Firestore rules already
  // let any player in the game update it at any time.
  const handleEndGame = async () => {
    if (!isPlayer) return;
    if (!window.confirm("End this game now for everyone? This can't be undone.")) return;
    await updateDoc(gameRef(), {
      status: 'finished',
      result: null,
      resultReason: 'ended_early',
      endedBy: user?.uid || null,
      endedByName: myPlayer?.displayName || null,
      finishedAt: new Date().toISOString(),
    });
  };

  const handlePlayAgain = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/chess/rematch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to start rematch.');
      navigate(`/games/chess/${json.gameId}`);
    } catch (err: any) {
      setError(err.message || 'Failed to start rematch.');
    } finally {
      setBusy(false);
    }
  };

  const resultText = (() => {
    if (game.status !== 'finished') return '';
    if (game.resultReason === 'ended_early') return `Game ended early${game.endedByName ? ` by ${game.endedByName}` : ''}.`;
    if (game.result === 'draw') {
      const reason = game.resultReason === 'stalemate' ? 'stalemate' :
        game.resultReason === 'threefold_repetition' ? 'threefold repetition' :
        game.resultReason === 'fifty_move_rule' ? 'the fifty-move rule' :
        game.resultReason === 'insufficient_material' ? 'insufficient material' : 'agreement';
      return `Draw by ${reason}.`;
    }
    if (game.result) {
      const winner = players.find((p) => p.color === game.result);
      const reason = game.resultReason === 'resignation' ? 'resignation' : 'checkmate';
      return `${winner?.displayName || COLOR_LABEL[game.result]} wins by ${reason}!`;
    }
    return 'Game over.';
  })();

  const opponent = players.find((p) => p.uid !== user?.uid && p.color !== myColor) || players.find((p) => p.color !== myColor);
  const me = players.find((p) => p.color === myColor);
  const turnColor = chess.turn();
  const isFinished = game.status === 'finished';
  const decided = isFinished && !!game.result && game.resultReason !== 'ended_early';
  const iWon = decided && game.result === myColor && isPlayer;
  const iLost = decided && game.result !== 'draw' && game.result !== myColor && isPlayer;
  const isDraw = isFinished && game.result === 'draw';
  const movesPlayed = Math.ceil((game.history?.length || 0) / 2);
  const durationMs = game.startedAt && game.finishedAt ? Math.max(0, new Date(game.finishedAt).getTime() - new Date(game.startedAt).getTime()) : 0;
  const durationLabel = (() => {
    const total = Math.round(durationMs / 1000);
    if (total <= 0) return '—';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}:${String(s).padStart(2, '0')}`;
  })();
  const reasonWord =
    game.resultReason === 'resignation' ? 'Resignation'
    : game.resultReason === 'stalemate' ? 'Stalemate'
    : game.resultReason === 'threefold_repetition' ? 'Repetition'
    : game.resultReason === 'fifty_move_rule' ? 'Fifty-move rule'
    : game.resultReason === 'insufficient_material' ? 'Not enough pieces'
    : game.resultReason === 'draw_agreed' ? 'Agreement'
    : game.resultReason === 'ended_early' ? 'Ended early'
    : 'Checkmate';
  const winnerPlayer = decided && game.result !== 'draw' ? players.find((p) => p.color === game.result) : undefined;
  const bigWord = isDraw ? 'DRAW' : iLost ? (game.resultReason === 'resignation' ? 'RESIGNED' : 'CHECKMATED') : game.resultReason === 'resignation' ? 'VICTORY!' : 'CHECKMATE!';
  const bigLine = isDraw
    ? `Honours even — ${reasonWord.toLowerCase()}.`
    : iWon
    ? game.resultReason === 'resignation' ? 'Your opponent resigned. The board is yours.' : CHECKMATE_LINES[(game.history?.length || 0) % CHECKMATE_LINES.length]
    : iLost
    ? 'Good fight. Set them up again?'
    : `${winnerPlayer?.displayName || COLOR_LABEL[game.result as PlayerColor]} wins by ${reasonWord.toLowerCase()}.`;

  const winShare =
    iWon && decided
      ? buildWinShare({
          gameName: 'Chess',
          hero: { kind: 'chess' as const, fen: game.fen, winnerColor: myColor, lastMove: game.lastMove, reason: game.resultReason === 'resignation' ? 'resignation' : 'checkmate', moves: movesPlayed },
          winnerLabel: myPlayer?.displayName || 'Player',
          standings: [
            { name: myPlayer?.displayName || 'Player', label: game.resultReason === 'resignation' ? 'Opponent resigned' : 'Checkmate', isWinner: true },
            { name: opponent?.displayName || 'Opponent', isWinner: false },
          ],
          detail: game.resultReason === 'resignation' ? 'Won by resignation' : 'Won by checkmate',
        })
      : null;

  const bannerText = isFinished
    ? resultText
    : isMyTurn
    ? inCheck ? 'Check! Protect your king' : 'Your move'
    : isPlayer
    ? `${opponent?.displayName || 'Opponent'} is thinking…`
    : `${COLOR_LABEL[turnColor]} to move`;
  const bannerDanger = !isFinished && inCheck;

  const pill = (p: (typeof players)[number] | undefined, color: PlayerColor, isMe: boolean) => {
    const active = !isFinished && turnColor === color;
    const taken = captured[color];
    const ahead = color === 'w' ? edge : -edge;
    return (
      <div className={clsx('flex items-center gap-2.5 rounded-2xl px-2.5 py-1.5 border-2 backdrop-blur-sm', active ? 'bg-black/55 border-amber-300 shadow-[0_0_16px_rgba(245,196,81,0.45)]' : 'bg-black/35 border-white/10')}>
        <div className="relative shrink-0 w-9 h-9">
          <div className="w-full h-full rounded-full bg-slate-600 flex items-center justify-center font-black text-sm overflow-hidden border-2" style={{ borderColor: color === 'w' ? '#f1f5f9' : '#475569' }}>
            {p?.photoURL ? <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : (p?.displayName || '?').slice(0, 1)}
          </div>
          {p && <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5" />}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-[13px] font-extrabold truncate">{isMe ? `You · ${p?.displayName || ''}` : p?.displayName || 'Waiting…'}</p>
          <p className="text-[10px] font-bold text-white/55">{COLOR_LABEL[color]}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0 text-[15px] leading-none tracking-[-2px]">
          {taken.map((t, i) => (
            <span key={i} style={{ color: color === 'w' ? '#334155' : '#e2e8f0', textShadow: color === 'w' ? '0 0 2px #cbd5e1' : '0 0 2px #0f172a' }}>{PIECE_GLYPH[t]}</span>
          ))}
          {ahead > 0 && <span className="ml-1.5 text-[11px] font-black text-emerald-400 tracking-normal">+{ahead}</span>}
        </div>
      </div>
    );
  };

  const boardView = (cells: typeof board, interactive: boolean, size?: string) => (
    <div
      className="relative grid overflow-hidden rounded-xl mx-auto shadow-[0_10px_30px_rgba(0,0,0,0.6),0_0_0_3px_#1f2a47]"
      style={{ gridTemplateColumns: 'repeat(8, 1fr)', gridTemplateRows: 'repeat(8, 1fr)', aspectRatio: '1', width: size || 'min(100%, calc(100dvh - 330px))', containerType: 'inline-size' }}
    >
      {cells.map((row) =>
        row.map((cell) => {
          const r = 8 - Number(cell.square[1]);
          const c = 'abcdefgh'.indexOf(cell.square[0]);
          const isDark = (r + c) % 2 === 1;
          const isLast = !!game.lastMove && (game.lastMove.from === cell.square || game.lastMove.to === cell.square);
          const isSelected = interactive && selectedSquare === cell.square;
          const isLegalTarget = interactive && legalMoves.some((m) => m.to === cell.square);
          const isKingInCheck = (inCheck || game.resultReason === 'checkmate') && cell.piece?.type === 'k' && cell.piece.color === turnColor;
          return (
            <div
              key={cell.square}
              role={interactive ? 'button' : undefined}
              onClick={interactive ? () => handleSquareTap(cell.square) : undefined}
              className={clsx('relative flex items-center justify-center select-none', interactive && 'cursor-pointer')}
              style={{ backgroundColor: isDark ? DARK_SQUARE : LIGHT_SQUARE }}
            >
              {isLast && <div className="absolute inset-0" style={{ background: 'rgba(245,196,81,0.45)' }} />}
              {isSelected && <div className="absolute inset-0" style={{ background: 'rgba(61,220,132,0.55)' }} />}
              {isKingInCheck && <div className="absolute inset-0" style={{ background: 'radial-gradient(circle, rgba(255,77,94,0.95), rgba(255,77,94,0.35) 70%)' }} />}
              {isLegalTarget && !cell.piece && <div className="absolute w-[30%] h-[30%] rounded-full bg-emerald-600/70" />}
              {isLegalTarget && cell.piece && <div className="absolute inset-0 border-[3px] border-emerald-600/80 rounded-sm" />}
              {cell.piece && (
                <span className="relative leading-none text-3xl" style={{ ...pieceStyle(cell.piece.color), fontSize: size ? '10.5cqw' : '10.6cqw' }}>
                  {PIECE_GLYPH[cell.piece.type]}
                </span>
              )}
            </div>
          );
        }),
      )}
    </div>
  );

  const confetti = Array.from({ length: 36 }).map((_, i) => {
    const ang = (i / 36) * Math.PI * 2 + (i % 3) * 0.2;
    const dist = 120 + ((i * 37) % 100);
    return { dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist, color: ['#fbbf24', '#f87171', '#60a5fa', '#4ade80', '#fff', '#c084fc'][i % 6], delay: (i % 7) * 0.04, rot: (i * 57) % 360 };
  });

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <ReactionOverlay reactions={floatingReactions} />
      {showHelp && <GameHelpModal content={CHESS_HELP} onClose={() => setShowHelp(false)} />}
      {showChat && user && (
        <ChatPanel
          collectionName="chessGames"
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

      {/* Celebration — checkmate / resignation win, a quieter one for a loss or draw */}
      {showCelebration && decided && (
        <div
          role="button"
          tabIndex={0}
          onClick={dismissCelebration}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') dismissCelebration(); }}
          className="fixed inset-0 z-[230] flex items-center justify-center cursor-pointer overflow-hidden"
          style={{ background: iLost ? 'radial-gradient(circle at 50% 45%, #3b1d28dd, rgba(0,0,0,0.88) 70%)' : 'radial-gradient(circle at 50% 42%, #5a3d0acc, rgba(5,7,12,0.92) 70%)', animation: 'chFade 0.25s ease-out' }}
        >
          <style>{`
            @keyframes chFade{from{opacity:0}to{opacity:1}}
            @keyframes chPop{0%{transform:scale(.2) rotate(-6deg);opacity:0}55%{transform:scale(1.2) rotate(2deg);opacity:1}100%{transform:scale(1) rotate(0)}}
            @keyframes chCrown{0%{transform:translateY(-70px) scale(.3);opacity:0}60%{transform:translateY(6px) scale(1.2);opacity:1}100%{transform:translateY(0) scale(1)}}
            @keyframes chKing{0%{transform:translateX(-60px);opacity:0}100%{transform:translateX(0);opacity:1}}
            @keyframes chFall{0%{transform:rotate(0)}100%{transform:rotate(78deg) translate(10px,6px)}}
            @keyframes chBurst{0%{transform:translate(0,0) rotate(0) scale(.4);opacity:1}100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(1);opacity:0}}
            @keyframes chRise{0%{transform:translateY(16px);opacity:0}100%{transform:translateY(0);opacity:1}}
          `}</style>
          {!iLost && !isDraw && (
            <div className="absolute left-1/2 top-[42%]">
              {confetti.map((c, i) => (
                <i key={i} className="absolute block w-2 h-3 rounded-[2px]" style={{ background: c.color, ['--dx' as any]: `${c.dx}px`, ['--dy' as any]: `${c.dy}px`, ['--rot' as any]: `${c.rot}deg`, animation: `chBurst 1.3s ease-out ${0.8 + c.delay}s both` }} />
              ))}
            </div>
          )}
          <div className="relative text-center px-6 flex flex-col items-center">
            <span className="text-[4.2rem] leading-none" style={{ animation: 'chCrown 0.7s cubic-bezier(.2,1.3,.4,1) 0.1s both' }}>{isDraw ? '🤝' : iLost ? '🏳️' : '👑'}</span>
            {!isDraw && (
              <div className="flex items-end gap-3 mt-2 text-[2.6rem] leading-none">
                <span style={{ ...pieceStyle(game.result as PlayerColor), animation: 'chKing 0.5s ease-out 0.35s both', filter: 'drop-shadow(0 0 12px #f5c451)' }}>{PIECE_GLYPH.k}</span>
                <span style={{ ...pieceStyle(game.result === 'w' ? 'b' : 'w'), display: 'inline-block', transformOrigin: 'bottom right', animation: 'chKing 0.5s ease-out 0.45s both, chFall 0.5s ease-in 1.1s both', filter: 'drop-shadow(0 0 10px #ff4d5e)' }}>{PIECE_GLYPH.k}</span>
              </div>
            )}
            <p
              className="mt-4 text-[3rem] leading-none font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-amber-100 via-amber-300 to-amber-600 drop-shadow-[0_6px_0_rgba(0,0,0,0.45)]"
              style={{ animation: 'chPop 0.6s cubic-bezier(.2,1.3,.4,1) 0.7s both' }}
            >
              {bigWord}
            </p>
            <p className="mt-3 text-sm font-extrabold text-white max-w-[16rem] leading-snug" style={{ animation: 'chRise 0.4s ease-out 1.1s both' }}>{bigLine}</p>
            <p className="mt-3 inline-block px-4 py-1.5 rounded-full text-xs font-black text-amber-950 bg-amber-300 shadow-lg" style={{ animation: 'chRise 0.4s ease-out 1.25s both' }}>
              {movesPlayed} moves · {reasonWord}
            </p>
          </div>
        </div>
      )}

      {/* Full-screen table (covers the app header and tab bar) */}
      <div className="fixed inset-0 z-[150] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white bg-[radial-gradient(ellipse_at_50%_0%,#1a2540_0%,#0b1020_60%,#070a14_100%)]">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(rgba(255,255,255,0.14)_1px,transparent_1.5px)] [background-size:24px_24px]" />

        <header className="relative shrink-0 flex items-center gap-2 px-3 pt-2">
          <button onClick={() => navigate('/games/chess')} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center" aria-label="Back">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <div className="leading-tight">
            <h1 className="text-[15px] font-black">Chess</h1>
            <span className="text-[8px] font-bold tracking-[0.14em] text-white/60">{game.status === 'waiting' ? 'WAITING FOR OPPONENT' : `MOVE ${movesPlayed + (turnColor === 'w' && !isFinished ? 1 : 0)}`}</span>
          </div>
          <ReactionButton onSend={handleSendReaction} />
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
            <HelpButton onClick={() => setShowHelp(true)} className="!text-white" />
            {isFinished ? (
              <button onClick={() => setShowResultPanel(true)} className="p-1.5 text-amber-300 shrink-0" aria-label="Show result">
                <span className="material-symbols-outlined text-[22px] block">emoji_events</span>
              </button>
            ) : isPlayer && game.status === 'active' ? (
              <button onClick={handleEndGame} className="p-1.5 text-red-300 shrink-0" aria-label="Leave game">
                <span className="material-symbols-outlined text-[22px] block">logout</span>
              </button>
            ) : null}
          </div>
        </header>

        {error && <p className="relative text-xs font-bold text-red-300 px-4 pt-1">{error}</p>}

        {game.status === 'waiting' && (
          <div className="relative flex-1 overflow-y-auto px-4 py-4">
            <div className="mx-auto max-w-md bg-white text-on-surface rounded-3xl p-5 space-y-4 shadow-2xl">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-black text-primary">Waiting for opponent</p>
                <div className="flex items-center gap-1.5">
                  <button onClick={handleCopyCode} className="text-xs font-bold text-primary flex items-center gap-1 px-3 py-1.5 bg-primary/5 rounded-full">
                    <span className="material-symbols-outlined text-[14px]">content_copy</span>
                    {game.code}
                  </button>
                  <ShareGameButton gameLabel="Chess" code={game.code} path={`/games/chess/${gameId}`} className="text-xs font-bold text-white flex items-center gap-1 px-3 py-1.5 bg-[#25D366] rounded-full" />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {players.map((p) => (
                  <div key={p.uid} className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold" style={{ backgroundColor: p.color === 'w' ? '#f3f4f6' : '#1f2937', color: p.color === 'w' ? '#1f2937' : '#f3f4f6' }}>
                    {p.displayName} · {COLOR_LABEL[p.color]}
                  </div>
                ))}
              </div>
              {!isPlayer && players.length < 2 && (
                <button onClick={handleJoin} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">Join Game</button>
              )}
              {isPlayer && (
                <button onClick={() => setShowInvite((v) => !v)} className="w-full py-2.5 border border-border-subtle text-primary font-bold rounded-xl text-sm flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-[18px]">group_add</span>
                  Invite Group Members
                </button>
              )}
              {showInvite && <InvitePicker groupIds={groupIds} alreadyIn={players.map((p) => p.uid)} onInvite={handleInvite} extraCandidates={friendCandidates} />}
              {game.hostUid === user?.uid && (
                <button onClick={handleDeleteGame} className="w-full py-2.5 text-error/70 font-bold text-sm">Delete Game</button>
              )}
            </div>
          </div>
        )}

        {(game.status === 'active' || isFinished) && (
          <div className="relative flex-1 min-h-0 flex flex-col px-3 pt-2 pb-2 gap-2">
            {pill(opponent, myColor === 'w' ? 'b' : 'w', false)}

            <div className="flex justify-center">
              <span className={clsx('px-4 py-1 rounded-full text-[11px] font-extrabold border', bannerDanger ? 'bg-red-500/20 text-red-300 border-red-400/50 animate-pulse' : isMyTurn ? 'bg-amber-300/15 text-amber-300 border-amber-300/40' : 'bg-white/8 text-white/70 border-white/15')}>
                {isMyTurn && !bannerDanger ? '♞ ' : ''}{bannerText}
              </span>
            </div>

            <div className="flex-1 min-h-0 flex items-center justify-center">{boardView(board, true)}</div>

            {pill(me, myColor, true)}

            {game.history && game.history.length > 0 && (
              <div ref={movesRef} className="flex gap-1.5 overflow-x-auto no-scrollbar text-[10px] font-bold whitespace-nowrap">
                {game.history.map((san, i) => (
                  <span key={i} className={clsx('px-2 py-0.5 rounded-lg shrink-0', i === game.history.length - 1 ? 'bg-amber-300 text-amber-950' : 'bg-white/10 text-white/70')}>
                    {i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ''}{san}
                  </span>
                ))}
              </div>
            )}

            {game.drawOfferBy && game.status === 'active' && isPlayer && (
              <div className="rounded-2xl border-2 border-amber-300/60 bg-black/50 p-2.5">
                {game.drawOfferBy === user?.uid ? (
                  <p className="text-xs text-white/70 italic text-center">Draw offer sent — waiting for a response.</p>
                ) : (
                  <div className="flex items-center gap-2">
                    <p className="flex-1 text-xs font-extrabold">Your opponent offers a draw</p>
                    <button onClick={() => handleRespondDraw(true)} className="px-3 py-1.5 bg-emerald-500 text-white font-black rounded-lg text-xs">Accept</button>
                    <button onClick={() => handleRespondDraw(false)} className="px-3 py-1.5 bg-white/15 text-white font-black rounded-lg text-xs">Decline</button>
                  </div>
                )}
              </div>
            )}

            {isPlayer && game.status === 'active' && !game.drawOfferBy && (
              <div className="flex gap-2">
                <button onClick={handleOfferDraw} disabled={busy} className="flex-1 py-2.5 rounded-xl text-xs font-extrabold bg-white/10 border border-white/15 disabled:opacity-50">🤝 Offer Draw</button>
                <button onClick={handleResign} disabled={busy} className="flex-1 py-2.5 rounded-xl text-xs font-extrabold bg-red-500/20 text-red-300 border border-red-400/30 disabled:opacity-50">🏳 Resign</button>
              </div>
            )}
          </div>
        )}
      </div>

      {promotionPending && (
        <div className="fixed inset-0 z-[260] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setPromotionPending(null)}>
          <div className="bg-[#121a2e] border border-white/15 rounded-3xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-black text-amber-300 text-center">Promote to</p>
            <div className="flex gap-2">
              {PROMOTION_CHOICES.map((choice) => (
                <button
                  key={choice.type}
                  onClick={() => commitMove(promotionPending.from, promotionPending.to, choice.type)}
                  className="w-16 h-16 rounded-2xl border border-white/15 bg-white/10 flex items-center justify-center text-4xl active:scale-95"
                  title={choice.label}
                >
                  <span style={{ ...pieceStyle(myColor), ...(myColor === 'b' ? { color: '#e2e8f0' } : null) }}>{PIECE_GLYPH[choice.type]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Post-game screen — dismissible so the final board can be studied; trophy button reopens it */}
      {isFinished && showResultPanel && !showCelebration && (
        <div className="fixed inset-0 z-[280] flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowResultPanel(false)} />
          <div className="relative w-full sm:max-w-sm max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl p-5 text-center text-white border border-white/10 bg-[radial-gradient(ellipse_at_50%_0%,#1a2540_0%,#0b1020_65%,#070a14_100%)]">
            {decided && !isDraw && !iLost && <Fireworks />}
            <button onClick={() => setShowResultPanel(false)} className="absolute top-3 right-3 p-1.5 text-white/60 rounded-full z-10" aria-label="Close">
              <span className="material-symbols-outlined text-[20px] block">close</span>
            </button>
            <p className="relative text-[11px] font-extrabold tracking-[0.16em] text-amber-300">
              {isDraw ? 'DRAW' : iWon ? 'VICTORY' : iLost ? 'DEFEAT' : 'GAME OVER'} · {reasonWord.toUpperCase()}
            </p>
            <p className="relative text-5xl mt-1" style={pieceStyle('w')}>{isDraw ? '🤝' : game.resultReason === 'ended_early' ? '🏁' : '♔'}</p>
            <p className="relative text-base font-black mt-1">{resultText}</p>
            <div className="relative mt-3">{boardView(orientedBoard(chess, 'w'), false, '170px')}</div>
            <div className="relative grid grid-cols-3 gap-2 mt-4">
              <div className="rounded-xl bg-white/8 border border-white/10 py-2"><p className="text-lg font-black">{movesPlayed}</p><p className="text-[9px] font-bold uppercase text-white/55">Moves</p></div>
              <div className="rounded-xl bg-white/8 border border-white/10 py-2"><p className="text-lg font-black">{edge === 0 ? '0' : `${edge > 0 ? 'W' : 'B'} +${Math.abs(edge)}`}</p><p className="text-[9px] font-bold uppercase text-white/55">Material</p></div>
              <div className="rounded-xl bg-white/8 border border-white/10 py-2"><p className="text-lg font-black">{durationLabel}</p><p className="text-[9px] font-bold uppercase text-white/55">Time</p></div>
            </div>
            <div className="relative flex flex-col gap-2 mt-4">
              {winShare && <ShareWinButton card={winShare.card} caption={winShare.caption} />}
              <button onClick={() => setShowResultPanel(false)} className="w-full py-3 bg-white/10 border border-white/15 text-white font-extrabold rounded-2xl text-sm">View the finished board</button>
              {isPlayer && (
                <button
                  onClick={() => (game.rematchGameId ? navigate(`/games/chess/${game.rematchGameId}`) : handlePlayAgain())}
                  disabled={busy}
                  className="w-full py-3 bg-gradient-to-r from-emerald-500 to-emerald-400 text-emerald-950 font-black rounded-2xl disabled:opacity-50"
                >
                  {game.rematchGameId ? 'Join Rematch' : busy ? 'Starting…' : 'Rematch (swap sides)'}
                </button>
              )}
              <button onClick={() => navigate('/tools?category=games')} className="w-full py-3 bg-white/10 border border-white/15 text-white font-extrabold rounded-2xl text-sm">Back to Games</button>
              {game.hostUid === user?.uid && (
                <button onClick={handleDeleteGame} className="text-red-300/80 font-bold text-sm pt-1">Delete Game</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
