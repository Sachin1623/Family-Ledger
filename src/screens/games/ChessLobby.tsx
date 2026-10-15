import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, doc, getDoc, setDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { generateGameCode } from '../../lib/chess';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { CHESS_HELP } from '../../lib/gameHelp';
import { GameLobbyShell, GoldButton, SectionLabel, CodeJoin, LobbyGameCard, IconAction, turnChipFor, lobbyStats } from '../../components/GameLobbyKit';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export default function ChessLobby() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [myGamesValue, loading] = useCollection(
    user ? query(collection(db, 'chessGames'), where('playerUids', 'array-contains', user.uid)) : null,
  );
  const myGames = (myGamesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    .filter((g) => g.status !== 'finished')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const handleCreate = async () => {
    if (!user) return;
    setCreating(true);
    setError(null);
    try {
      const gameRef = doc(collection(db, 'chessGames'));

      let code = generateGameCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await getDoc(doc(db, 'chessGameCodes', code));
        if (!existing.exists()) break;
        code = generateGameCode();
      }

      const hostPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        color: 'w',
      };

      await setDoc(gameRef, {
        hostUid: user.uid,
        code,
        status: 'waiting',
        players: [hostPlayer],
        playerUids: [user.uid],
        fen: START_FEN,
        history: [],
        lastMove: null,
        drawOfferBy: null,
        result: null,
        resultReason: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        rematchGameId: null,
      });
      await setDoc(doc(db, 'chessGameCodes', code), { gameId: gameRef.id, hostUid: user.uid });

      navigate(`/games/chess/${gameRef.id}`);
    } catch (err) {
      console.error('Failed to create Chess game:', err);
      setError('Failed to create game.');
    } finally {
      setCreating(false);
    }
  };

  // Host-only, and only while the game hasn't actually started (server also enforces this) — an
  // active game has the other player mid-match.
  const handleDelete = async (e: React.MouseEvent, gameId: string) => {
    e.stopPropagation();
    if (!user) return;
    if (!window.confirm('Delete this game? This cannot be undone.')) return;
    setDeletingId(gameId);
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
    } catch (err: any) {
      console.error('Failed to delete Chess game:', err);
      setError(err.message || 'Failed to delete game.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleJoinByCode = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    setJoining(true);
    setError(null);
    try {
      const codeSnap = await getDoc(doc(db, 'chessGameCodes', code));
      if (!codeSnap.exists()) {
        setError('No game found with that code.');
        return;
      }
      navigate(`/games/chess/${codeSnap.data().gameId}`);
    } catch (err) {
      console.error('Failed to look up code:', err);
      setError('Failed to look up that code.');
    } finally {
      setJoining(false);
    }
  };

  return (
    <GameLobbyShell
      title="Chess"
      emoji="♞"
      tagline="Online duel for 2 players. Share a code or invite family."
      gradient={['#2b3f7a', '#162250']}
      stats={lobbyStats(myGames, user?.uid, 'chess')}
      ranksPath="/games/ranks/chess"
      help={{ content: CHESS_HELP }}
      error={error}
    >
      <GoldButton onClick={handleCreate} disabled={creating}>{creating ? 'Creating…' : '＋ New game'}</GoldButton>

      <CodeJoin value={joinCode} onChange={setJoinCode} onJoin={handleJoinByCode} joining={joining} />

      <section className="space-y-2">
        <SectionLabel>{`Your games · ${myGames.length}`}</SectionLabel>
        {loading && <p className="text-sm text-white/60 px-1">Loading…</p>}
        {!loading && myGames.length === 0 && <p className="text-sm text-white/50 italic px-1">No games in progress — start one above.</p>}
        <div className="space-y-2">
          {myGames.map((g) => {
            const other = (g.players || []).find((p: any) => p.uid !== user?.uid);
            return (
              <LobbyGameCard
                key={g.id}
                players={(g.players || []).map((p: any) => ({ uid: p.uid, photoURL: p.photoURL, displayName: p.displayName }))}
                title={g.status === 'waiting' ? 'Open table' : `vs ${other?.displayName || 'Opponent'}`}
                subtitle={g.status === 'waiting' ? `Code ${g.code} · tap to share` : `Move ${Math.ceil((g.history?.length || 0) / 2) + 1} · code ${g.code}`}
                chip={turnChipFor(g, user?.uid, 'chess')}
                onClick={() => navigate(`/games/chess/${g.id}`)}
                actions={g.hostUid === user?.uid && g.status !== 'active' ? <IconAction icon="delete" label="Delete game" onClick={(e) => handleDelete(e, g.id)} disabled={deletingId === g.id} /> : null}
              />
            );
          })}
        </div>
      </section>
    </GameLobbyShell>
  );
}
