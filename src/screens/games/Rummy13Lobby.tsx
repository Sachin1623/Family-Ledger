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
import { GameLobbyShell, GoldButton, SectionLabel, CodeJoin, LobbyGameCard, IconAction, NewGameSheet, OptionCard, PillPicker, CardPicker, SwitchRow, turnChipFor, lobbyStats } from '../../components/GameLobbyKit';

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
  const [showNew, setShowNew] = useState(false);
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
    <GameLobbyShell
      title="13-Card Rummy"
      emoji="🃏"
      tagline="Classic Indian Rummy. Single deal or Pool 101 / 201."
      gradient={['#1d5a3a', '#0f2f24']}
      stats={lobbyStats(myTables, user?.uid, 'none')}
      ranksPath="/games/ranks/rummy13"
      help={{ content: RUMMY13_HELP }}
      error={showNew ? null : error}
    >
      <GoldButton onClick={() => setShowNew(true)}>＋ New table</GoldButton>

      <CodeJoin value={joinCode} onChange={setJoinCode} onJoin={handleJoinByCode} joining={joining} />

      <section className="space-y-2">
        <SectionLabel>{`Your tables · ${myTables.length}`}</SectionLabel>
        {loading && <p className="text-sm text-white/60 px-1">Loading…</p>}
        {!loading && myTables.length === 0 && <p className="text-sm text-white/50 italic px-1">Nothing in progress — start one above.</p>}
        <div className="space-y-2">
          {myTables.map((g) => (
            <LobbyGameCard
              key={g.id}
              players={(g.players || []).map((p: any) => ({ uid: p.uid, photoURL: p.photoURL, displayName: p.displayName, isBot: p.isBot }))}
              title={g.status === 'waiting' ? 'Waiting for players' : 'In progress'}
              subtitle={`${FORMATS.find((f) => f.id === g.format)?.label || g.format} · code ${g.code}`}
              chip={turnChipFor(g, user?.uid, 'none')}
              onClick={() => navigate(`/games/rummy13/${g.id}`)}
              actions={g.hostUid === user?.uid && g.status !== 'active' ? <IconAction icon="delete" label="Delete" onClick={(e) => handleDelete(e, g.id)} disabled={deletingId === g.id} /> : null}
            />
          ))}
        </div>
      </section>

      <NewGameSheet open={showNew} onClose={() => setShowNew(false)} title="New table" subtitle="13-Card Rummy" createLabel="Create table" creating={creating} onCreate={handleCreate} error={error}>
        <OptionCard label="Format">
          <div className="space-y-2">
            {FORMATS.map((f) => (
              <button key={f.id} onClick={() => setFormat(f.id)} className={clsx('w-full rounded-2xl p-3 text-left border-2 transition-all', format === f.id ? 'border-amber-300 bg-[#2a1d05] shadow-[0_0_14px_rgba(245,196,81,0.25)]' : 'border-[#2c3a63] bg-[#0c1230]')}>
                <p className="text-xs font-black">{f.label}</p>
                <p className="text-[10px] font-bold text-white/50">{f.sub}</p>
              </button>
            ))}
          </div>
        </OptionCard>
        <OptionCard label="Players">
          <PillPicker options={PLAYER_COUNTS as readonly number[]} value={maxPlayers} onChange={setMaxPlayers} />
        </OptionCard>
      </NewGameSheet>
    </GameLobbyShell>
  );
}
