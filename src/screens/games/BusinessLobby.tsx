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
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black text-primary">Business</h1>
            <p className="text-sm text-text-muted mt-1">Online multiplayer, 2-6 players. Indian city board.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <HelpButton onClick={() => setShowHelp(true)} />
            <button
              onClick={() => navigate('/games/ranks/business')}
              className="px-3 py-2 bg-primary/10 text-primary rounded-xl text-xs font-bold flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">leaderboard</span>
              Ranks
            </button>
          </div>
        </div>

        {showHelp && <GameHelpModal content={BUSINESS_HELP} onClose={() => setShowHelp(false)} />}

        {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

        <div className="bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
          <p className="text-xs font-bold text-text-muted uppercase tracking-wider">House Rules (this game)</p>
          {HOUSE_RULE_TOGGLES.map((t) => (
            <label key={t.key} className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={houseRules[t.key]}
                onChange={(e) => setHouseRules((hr) => ({ ...hr, [t.key]: e.target.checked }))}
                className="mt-0.5 w-4 h-4 accent-primary shrink-0"
              />
              <span>
                <span className="block text-sm font-bold text-on-surface">{t.label}</span>
                <span className="block text-[11px] text-text-muted">{t.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <button
          onClick={handleCreate}
          disabled={creating}
          className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
        >
          <span className="material-symbols-outlined">add_circle</span>
          {creating ? 'Creating…' : 'New Game'}
        </button>

        <div className="bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
          <p className="text-xs font-bold text-text-muted uppercase tracking-wider">Join by Code</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="e.g. K7XQ2R"
              maxLength={6}
              className="flex-1 bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none tracking-widest font-bold uppercase"
            />
            <button
              onClick={handleJoinByCode}
              disabled={joining || !joinCode.trim()}
              className="px-5 py-2 bg-primary/10 text-primary rounded-xl text-sm font-bold disabled:opacity-50"
            >
              {joining ? '…' : 'Join'}
            </button>
          </div>
        </div>

        <section className="space-y-2">
          <h2 className="text-xs font-bold text-primary uppercase tracking-widest px-1">Your Games</h2>
          {loading && <p className="text-sm text-text-muted px-1">Loading…</p>}
          {!loading && myGames.length === 0 && <p className="text-sm text-text-muted italic px-1">No games in progress.</p>}
          <div className="space-y-2">
            {myGames.map((g) => (
              <div
                key={g.id}
                onClick={() => navigate(`/games/business/${g.id}`)}
                className="bg-white rounded-2xl border border-border-subtle p-4 flex items-center justify-between cursor-pointer hover:shadow-sm transition-all"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex -space-x-2">
                    {(g.players || []).map((p: any) => (
                      <div key={p.uid} className="w-8 h-8 rounded-full border-2 border-white bg-primary flex items-center justify-center text-white text-xs font-bold">
                        {p.displayName?.slice(0, 1) || '?'}
                      </div>
                    ))}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">
                      {g.status === 'waiting' ? 'Waiting for players' : 'In progress'}
                    </p>
                    <p className="text-[10px] text-text-muted uppercase font-bold tracking-wider">Code: {g.code}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {g.hostUid === user?.uid && g.status !== 'active' && (
                    <button
                      onClick={(e) => handleDelete(e, g.id)}
                      disabled={deletingId === g.id}
                      className="p-2 text-error/70 disabled:opacity-40"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  )}
                  <span className="material-symbols-outlined text-text-muted">chevron_right</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
