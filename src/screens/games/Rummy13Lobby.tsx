import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, doc, getDoc, setDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { generateGameCode, type Rummy13Format } from '../../lib/rummy13';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { RUMMY13_HELP } from '../../lib/gameHelp';

const FORMATS: { id: Rummy13Format; label: string; sub: string }[] = [
  { id: 'single', label: 'Single Deal', sub: 'One hand, winner takes it' },
  { id: 'pool101', label: 'Pool 101', sub: 'Play until eliminated at 101' },
  { id: 'pool201', label: 'Pool 201', sub: 'Play until eliminated at 201' },
];

const PLAYER_COUNTS = [2, 3, 4, 5, 6];

export default function Rummy13Lobby() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [format, setFormat] = useState<Rummy13Format>('pool101');
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [myTablesValue, loading] = useCollection(
    user ? query(collection(db, 'rummy13Tables'), where('playerUids', 'array-contains', user.uid)) : null,
  );
  const myTables = (myTablesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    .filter((g) => g.status !== 'finished')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const handleCreate = async () => {
    if (!user) return;
    setCreating(true);
    setError(null);
    try {
      const tableRef = doc(collection(db, 'rummy13Tables'));

      let code = generateGameCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await getDoc(doc(db, 'rummy13TableCodes', code));
        if (!existing.exists()) break;
        code = generateGameCode();
      }

      const hostPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: 0,
        cumulativeScore: 0,
        eliminated: false,
      };

      await setDoc(tableRef, {
        hostUid: user.uid,
        code,
        status: 'waiting',
        format,
        poolLimit: format === 'pool101' ? 101 : format === 'pool201' ? 201 : null,
        maxPlayers,
        players: [hostPlayer],
        playerUids: [user.uid],
        currentDealId: null,
        dealNumber: 0,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        winnerUid: null,
        lastDealSummary: null,
        rematchGameId: null,
      });
      await setDoc(doc(db, 'rummy13TableCodes', code), { gameId: tableRef.id, hostUid: user.uid });

      navigate(`/games/rummy13/${tableRef.id}`);
    } catch (err) {
      console.error('Failed to create 13-Card Rummy table:', err);
      setError('Failed to create table.');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, tableId: string) => {
    e.stopPropagation();
    if (!user) return;
    if (!window.confirm('Delete this table? This cannot be undone.')) return;
    setDeletingId(tableId);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/rummy13/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: tableId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete table.');
    } catch (err: any) {
      console.error('Failed to delete 13-Card Rummy table:', err);
      setError(err.message || 'Failed to delete table.');
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
      const codeSnap = await getDoc(doc(db, 'rummy13TableCodes', code));
      if (!codeSnap.exists()) {
        setError('No table found with that code.');
        return;
      }
      navigate(`/games/rummy13/${codeSnap.data().gameId}`);
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
            <h1 className="text-2xl font-black text-primary">13-Card Rummy</h1>
            <p className="text-sm text-text-muted mt-1">Online multiplayer, 2-6 players. Classic Indian Rummy.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <HelpButton onClick={() => setShowHelp(true)} />
            <button
              onClick={() => navigate('/games/ranks/rummy13')}
              className="px-3 py-2 bg-primary/10 text-primary rounded-xl text-xs font-bold flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">leaderboard</span>
              Ranks
            </button>
          </div>
        </div>

        {showHelp && <GameHelpModal content={RUMMY13_HELP} onClose={() => setShowHelp(false)} />}

        {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

        <div className="bg-white rounded-2xl border border-border-subtle p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Format</label>
            <div className="grid grid-cols-3 gap-1.5">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  className={clsx(
                    'p-2.5 rounded-xl border text-center transition-all',
                    format === f.id ? 'border-primary bg-primary/5' : 'border-border-subtle',
                  )}
                >
                  <p className={clsx('text-xs font-black', format === f.id ? 'text-primary' : 'text-on-surface')}>{f.label}</p>
                  <p className="text-[9px] text-text-muted mt-0.5 leading-tight">{f.sub}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Players</label>
            <div className="flex gap-1.5">
              {PLAYER_COUNTS.map((n) => (
                <button
                  key={n}
                  onClick={() => setMaxPlayers(n)}
                  className={clsx(
                    'flex-1 py-2 rounded-xl border text-sm font-black transition-all',
                    maxPlayers === n ? 'border-primary bg-primary/5 text-primary' : 'border-border-subtle text-text-muted',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleCreate}
            disabled={creating}
            className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
          >
            <span className="material-symbols-outlined">add_circle</span>
            {creating ? 'Creating…' : 'New Table'}
          </button>
        </div>

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
          <h2 className="text-xs font-bold text-primary uppercase tracking-widest px-1">Your Tables</h2>
          {loading && <p className="text-sm text-text-muted px-1">Loading…</p>}
          {!loading && myTables.length === 0 && <p className="text-sm text-text-muted italic px-1">No tables in progress.</p>}
          <div className="space-y-2">
            {myTables.map((g) => (
              <div
                key={g.id}
                onClick={() => navigate(`/games/rummy13/${g.id}`)}
                className="bg-white rounded-2xl border border-border-subtle p-4 flex items-center justify-between cursor-pointer hover:shadow-sm transition-all"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex -space-x-2">
                    {(g.players || []).map((p: any) => (
                      <div key={p.uid} className="w-8 h-8 rounded-full border-2 border-white bg-primary flex items-center justify-center text-white text-xs font-bold overflow-hidden">
                        {p.photoURL ? (
                          <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                          p.displayName?.slice(0, 1) || '?'
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">
                      {g.status === 'waiting' ? 'Waiting for players' : 'In progress'}
                    </p>
                    <p className="text-[10px] text-text-muted uppercase font-bold tracking-wider">
                      {FORMATS.find((f) => f.id === g.format)?.label || g.format} · Code: {g.code}
                    </p>
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
