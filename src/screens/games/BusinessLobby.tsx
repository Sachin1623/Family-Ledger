import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, doc, getDoc, setDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import {
  generateGameCode,
  emptyProperties,
  DEFAULT_HOUSE_RULES,
  STARTING_CASH,
  shuffledIndexes,
  CHANCE_CARDS,
  COMMUNITY_CHEST_CARDS,
  type HouseRules,
} from '../../lib/business';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { BUSINESS_HELP } from '../../lib/gameHelp';
import { GameLobbyShell, GoldButton, SectionLabel, CodeJoin, LobbyGameCard, IconAction, NewGameSheet, OptionCard, PillPicker, CardPicker, SwitchRow, turnChipFor, lobbyStats } from '../../components/GameLobbyKit';

const HOUSE_RULE_TOGGLES: { key: keyof HouseRules; label: string; hint: string }[] = [
  { key: 'freeParkingJackpot', label: 'Free Parking Jackpot', hint: 'Taxes/fines pile up on Free Parking; landing there collects the pot' },
  { key: 'doubleRentFullSet', label: 'Double Rent on Full Set', hint: 'Owning a whole color group doubles rent even with no houses built' },
  { key: 'doubleSalaryOnExactGo', label: 'Double Salary on Exact GO', hint: 'Landing exactly on GO pays double salary' },
  { key: 'doublesExtraTurn', label: 'Bonus for Rolling Doubles', hint: 'Doubles grant another roll; 3 in a row sends you to Jail' },
];

export default function BusinessLobby() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [houseRules, setHouseRules] = useState<HouseRules>(DEFAULT_HOUSE_RULES);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [myGamesValue, loading] = useCollection(
    user ? query(collection(db, 'businessGames'), where('playerUids', 'array-contains', user.uid)) : null,
  );
  const myGames = (myGamesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    .filter((g) => g.status !== 'finished')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const handleCreate = async () => {
    if (!user) return;
    setCreating(true);
    setError(null);
    try {
      const gameRef = doc(collection(db, 'businessGames'));

      let code = generateGameCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await getDoc(doc(db, 'businessGameCodes', code));
        if (!existing.exists()) break;
        code = generateGameCode();
      }

      const hostPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: 0,
        cash: STARTING_CASH,
        position: 0,
        inJail: false,
        jailTurns: 0,
        getOutOfJailCards: 0,
        bankrupt: false,
        doublesStreak: 0,
      };

      await setDoc(gameRef, {
        hostUid: user.uid,
        code,
        status: 'waiting',
        players: [hostPlayer],
        playerUids: [user.uid],
        currentTurnSeatIndex: 0,
        turnPhase: 'roll',
        lastRoll: null,
        properties: emptyProperties(),
        chanceDeck: shuffledIndexes(CHANCE_CARDS.length),
        communityDeck: shuffledIndexes(COMMUNITY_CHEST_CARDS.length),
        freeParkingPot: 0,
        houseRules,
        pendingCard: null,
        auction: null,
        pendingTrade: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        winnerUid: null,
        finishedAt: null,
        rematchGameId: null,
      });
      await setDoc(doc(db, 'businessGameCodes', code), { gameId: gameRef.id, hostUid: user.uid });

      navigate(`/games/business/${gameRef.id}`);
    } catch (err) {
      console.error('Failed to create Business game:', err);
      setError('Failed to create game.');
    } finally {
      setCreating(false);
    }
  };

  // Host-only, and only while the game hasn't actually started (server also enforces this) — an
  // active game has other players mid-match, so ending it isn't a one-tap decision from this list.
  const handleDelete = async (e: React.MouseEvent, gameId: string) => {
    e.stopPropagation();
    if (!user) return;
    if (!window.confirm('Delete this game? This cannot be undone.')) return;
    setDeletingId(gameId);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/business/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete game.');
    } catch (err: any) {
      console.error('Failed to delete Business game:', err);
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
      const codeSnap = await getDoc(doc(db, 'businessGameCodes', code));
      if (!codeSnap.exists()) {
        setError('No game found with that code.');
        return;
      }
      navigate(`/games/business/${codeSnap.data().gameId}`);
    } catch (err) {
      console.error('Failed to look up code:', err);
      setError('Failed to look up that code.');
    } finally {
      setJoining(false);
    }
  };

  return (
    <GameLobbyShell
      title="Business"
      emoji="🏙️"
      tagline="Buy cities, collect rent, bankrupt your family. 2–6 players."
      gradient={['#1d5a3a', '#0f2f24']}
      stats={lobbyStats(myGames, user?.uid, 'seat')}
      ranksPath="/games/ranks/business"
      help={{ content: BUSINESS_HELP }}
      error={showNew ? null : error}
    >
      <GoldButton onClick={() => setShowNew(true)}>＋ New game</GoldButton>

      <CodeJoin value={joinCode} onChange={setJoinCode} onJoin={handleJoinByCode} joining={joining} />

      <section className="space-y-2">
        <SectionLabel>{`Your games · ${myGames.length}`}</SectionLabel>
        {loading && <p className="text-sm text-white/60 px-1">Loading…</p>}
        {!loading && myGames.length === 0 && <p className="text-sm text-white/50 italic px-1">No games in progress — start one above.</p>}
        <div className="space-y-2">
          {myGames.map((g) => (
            <LobbyGameCard
              key={g.id}
              players={(g.players || []).map((p: any) => ({ uid: p.uid, photoURL: p.photoURL, displayName: p.displayName }))}
              title={g.status === 'waiting' ? 'Waiting for players' : `${(g.players || []).length} players`}
              subtitle={`Code ${g.code}`}
              chip={turnChipFor(g, user?.uid, 'seat')}
              onClick={() => navigate(`/games/business/${g.id}`)}
              actions={g.hostUid === user?.uid && g.status !== 'active' ? <IconAction icon="delete" label="Delete game" onClick={(e) => handleDelete(e, g.id)} disabled={deletingId === g.id} /> : null}
            />
          ))}
        </div>
      </section>

      <NewGameSheet open={showNew} onClose={() => setShowNew(false)} title="New game" subtitle="Business · 2–6 players" createLabel="Create game" creating={creating} onCreate={handleCreate} error={error}>
        <OptionCard label="House rules (this game)">
          <div className="divide-y divide-[#1f2a47]">
            {HOUSE_RULE_TOGGLES.map((t) => (
              <SwitchRow key={t.key} label={t.label} hint={t.hint} checked={houseRules[t.key]} onChange={(v) => setHouseRules((hr) => ({ ...hr, [t.key]: v }))} />
            ))}
          </div>
        </OptionCard>
      </NewGameSheet>
    </GameLobbyShell>
  );
}
