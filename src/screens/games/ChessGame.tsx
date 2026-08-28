import React, { useEffect, useMemo, useState } from 'react';
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
import { useGameTurnPresence, notifyGameTurnClient } from '../../lib/gameTurnPresence';

const LIGHT_SQUARE = '#F0D9B5';
const DARK_SQUARE = '#B58863';

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

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <ReactionOverlay reactions={floatingReactions} />
      <main className="flex-1 p-4 md:p-6 max-w-md mx-auto w-full space-y-5 pb-24">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button onClick={() => navigate('/games/chess')} className="text-xs font-bold text-primary flex items-center gap-1">
              <span className="material-symbols-outlined text-[16px]">arrow_back</span>
              Chess
            </button>
            <ReactionButton onSend={handleSendReaction} />
          </div>
          <div className="flex items-center gap-2">
            {isPlayer && game.status === 'active' && (
              <button onClick={handleEndGame} className="p-2 text-error shrink-0" aria-label="Leave game">
                <span className="material-symbols-outlined text-[16px] block">logout</span>
              </button>
            )}
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} />
            <VoiceChatButton voice={voice} />
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
        </div>

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

        {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

        {game.status === 'waiting' && (
          <div className="bg-white rounded-2xl border border-border-subtle p-5 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-primary">Waiting for opponent</p>
              <div className="flex items-center gap-1.5">
                <button onClick={handleCopyCode} className="text-xs font-bold text-primary flex items-center gap-1 px-3 py-1.5 bg-primary/5 rounded-full">
                  <span className="material-symbols-outlined text-[14px]">content_copy</span>
                  {game.code}
                </button>
                <ShareGameButton
                  gameLabel="Chess"
                  code={game.code}
                  path={`/games/chess/${gameId}`}
                  className="text-xs font-bold text-white flex items-center gap-1 px-3 py-1.5 bg-[#25D366] rounded-full"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {players.map((p) => (
                <div
                  key={p.uid}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold"
                  style={{ backgroundColor: p.color === 'w' ? '#f3f4f6' : '#1f2937', color: p.color === 'w' ? '#1f2937' : '#f3f4f6' }}
                >
                  {p.displayName} · {COLOR_LABEL[p.color]}
                </div>
              ))}
            </div>

            {!isPlayer && players.length < 2 && (
              <button onClick={handleJoin} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">
                Join Game
              </button>
            )}

            {isPlayer && (
              <button onClick={() => setShowInvite((v) => !v)} className="w-full py-2.5 border border-border-subtle text-primary font-bold rounded-xl text-sm flex items-center justify-center gap-2">
                <span className="material-symbols-outlined text-[18px]">group_add</span>
                Invite Group Members
              </button>
            )}
            {showInvite && (
              <InvitePicker groupIds={groupIds} alreadyIn={players.map((p) => p.uid)} onInvite={handleInvite} extraCandidates={friendCandidates} />
            )}

            {game.hostUid === user?.uid && (
              <button onClick={handleDeleteGame} className="w-full py-2.5 text-error/70 font-bold text-sm">
                Delete Game
              </button>
            )}
          </div>
        )}

        {game.status === 'finished' && (
          <div className="relative bg-white rounded-2xl border border-border-subtle p-6 text-center space-y-3 overflow-hidden">
            {game.result && game.result !== 'draw' && game.resultReason !== 'ended_early' && <Fireworks />}
            <span className="relative material-symbols-outlined text-4xl text-primary">
              {game.resultReason === 'ended_early' ? 'flag' : game.result === 'draw' ? 'handshake' : 'emoji_events'}
            </span>
            <p className="relative text-lg font-black text-primary">{resultText}</p>
            {isPlayer && (
              <button
                onClick={() => (game.rematchGameId ? navigate(`/games/chess/${game.rematchGameId}`) : handlePlayAgain())}
                disabled={busy}
                className="relative w-full py-3 bg-success text-white font-bold rounded-2xl disabled:opacity-50"
              >
                {game.rematchGameId ? 'Join Rematch' : busy ? 'Starting…' : 'Play Again (Swap Sides)'}
              </button>
            )}
            <button onClick={() => navigate('/games/chess')} className="relative w-full py-3 bg-primary text-white font-bold rounded-2xl">
              Back to Chess
            </button>
            {game.hostUid === user?.uid && (
              <button onClick={handleDeleteGame} className="relative w-full py-2.5 text-error/70 font-bold text-sm">
                Delete Game
              </button>
            )}
          </div>
        )}

        {(game.status === 'active' || (game.status === 'finished' && game.result)) && (
          <>
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {players.map((p) => (
                <div
                  key={p.uid}
                  className={clsx('shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border-2', chess.turn() === p.color && game.status === 'active' ? 'border-primary' : 'border-transparent')}
                  style={{ backgroundColor: p.color === 'w' ? '#f3f4f6' : '#1f2937', color: p.color === 'w' ? '#1f2937' : '#f3f4f6' }}
                >
                  <PresenceDot uid={p.uid} className="w-2 h-2" />
                  {p.displayName} {chess.turn() === p.color && game.status === 'active' && '•'}
                </div>
              ))}
              {edge !== 0 && (
                <span className="shrink-0 text-[11px] font-black text-success px-2">{edge > 0 ? `White +${edge}` : `Black +${-edge}`}</span>
              )}
            </div>

            <p className="text-xs text-text-muted text-center">
              {game.status === 'finished'
                ? resultText
                : isMyTurn
                ? inCheck ? 'Your turn — you are in check!' : 'Your turn'
                : `Waiting for ${players.find((p) => p.uid !== user?.uid)?.displayName || 'opponent'}…`}
            </p>

            <div
              className="relative grid bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden mx-auto"
              style={{ gridTemplateColumns: 'repeat(8, 1fr)', gridTemplateRows: 'repeat(8, 1fr)', aspectRatio: '1', width: '100%' }}
            >
              {board.map((row, r) =>
                row.map((cell, c) => {
                  const isDark = (r + c) % 2 === 1;
                  const isSelected = selectedSquare === cell.square;
                  const isLegalTarget = legalMoves.some((m) => m.to === cell.square);
                  const isKingInCheck = inCheck && cell.piece?.type === 'k' && cell.piece.color === chess.turn();
                  return (
                    <div
                      key={cell.square}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleSquareTap(cell.square)}
                      className="relative flex items-center justify-center cursor-pointer select-none"
                      style={{ backgroundColor: isDark ? DARK_SQUARE : LIGHT_SQUARE }}
                    >
                      {isSelected && <div className="absolute inset-0 bg-primary/40" />}
                      {isKingInCheck && <div className="absolute inset-0 bg-error/50" />}
                      {isLegalTarget && !cell.piece && <div className="absolute w-1/3 h-1/3 rounded-full bg-primary/50" />}
                      {isLegalTarget && cell.piece && <div className="absolute inset-0 ring-4 ring-inset ring-primary/50 rounded-sm" />}
                      {cell.piece && (
                        <span className="relative text-3xl sm:text-4xl leading-none" style={pieceStyle(cell.piece.color)}>
                          {PIECE_GLYPH[cell.piece.type]}
                        </span>
                      )}
                    </div>
                  );
                }),
              )}
            </div>

            {/* `captured.w` is what WHITE has captured — i.e. black pieces taken off the board —
                so the fill color shown here is deliberately the opposite of the array's own key. */}
            {(captured.w.length > 0 || captured.b.length > 0) && (
              <div className="flex items-center justify-between px-1 text-lg">
                <div className="flex flex-wrap">{captured.b.map((p, i) => <span key={i} style={pieceStyle('w')}>{PIECE_GLYPH[p]}</span>)}</div>
                <div className="flex flex-wrap">{captured.w.map((p, i) => <span key={i} style={pieceStyle('b')}>{PIECE_GLYPH[p]}</span>)}</div>
              </div>
            )}

            {game.drawOfferBy && game.status === 'active' && (
              <div className="bg-white rounded-xl border-2 border-primary p-3 space-y-2">
                {game.drawOfferBy === user?.uid ? (
                  <p className="text-xs text-text-muted italic">Draw offer sent — waiting for a response.</p>
                ) : (
                  <>
                    <p className="text-sm font-bold text-primary">Your opponent offered a draw.</p>
                    <div className="flex gap-2">
                      <button onClick={() => handleRespondDraw(true)} className="flex-1 py-2 bg-primary text-white font-bold rounded-lg text-sm">Accept</button>
                      <button onClick={() => handleRespondDraw(false)} className="flex-1 py-2 bg-white border border-border-subtle rounded-lg text-sm font-bold">Decline</button>
                    </div>
                  </>
                )}
              </div>
            )}

            {isPlayer && game.status === 'active' && !game.drawOfferBy && (
              <div className="flex gap-2">
                <button onClick={handleOfferDraw} disabled={busy} className="flex-1 py-2.5 bg-white border border-border-subtle text-primary font-bold rounded-xl text-sm disabled:opacity-50">
                  Offer Draw
                </button>
                <button onClick={handleResign} disabled={busy} className="flex-1 py-2.5 bg-error/10 text-error font-bold rounded-xl text-sm disabled:opacity-50">
                  Resign
                </button>
              </div>
            )}

            {game.history && game.history.length > 0 && (
              <div className="bg-white rounded-2xl border border-border-subtle p-4">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-2">Moves</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-on-surface max-h-32 overflow-y-auto">
                  {game.history.map((san, i) => (
                    <span key={i}>
                      {i % 2 === 0 && <span className="text-text-muted font-bold">{Math.floor(i / 2) + 1}.</span>} {san}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {promotionPending && (
          <div className="fixed inset-0 z-[260] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setPromotionPending(null)}>
            <div className="bg-white rounded-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
              <p className="text-sm font-bold text-primary text-center">Promote to</p>
              <div className="flex gap-2">
                {PROMOTION_CHOICES.map((choice) => (
                  <button
                    key={choice.type}
                    onClick={() => commitMove(promotionPending.from, promotionPending.to, choice.type)}
                    className="w-16 h-16 rounded-xl border border-border-subtle bg-surface flex items-center justify-center text-3xl hover:bg-primary/10"
                    title={choice.label}
                  >
                    <span style={pieceStyle(myColor)}>{PIECE_GLYPH[choice.type]}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
