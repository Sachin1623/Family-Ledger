import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, doc, getDoc, setDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { generateGameCode, teamForSeat, type SpadePledgeFormat } from '../../lib/spadePledge';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { SPADE_PLEDGE_HELP } from '../../lib/gameHelp';
import { GameLobbyShell, GoldButton, SectionLabel, CodeJoin, LobbyGameCard, IconAction, NewGameSheet, OptionCard, PillPicker, CardPicker, SwitchRow, turnChipFor, lobbyStats } from '../../components/GameLobbyKit';

const FORMATS: { id: SpadePledgeFormat; label: string; sub: string }[] = [
  { id: 'partnership', label: 'Partnership', sub: '2v2, seated opposite your partner' },
  { id: 'ffa', label: 'Free-for-all', sub: '4 players, everyone for themselves' },
];

export default function SpadePledgeLobby() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [format, setFormat] = useState<SpadePledgeFormat>('partnership');
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [fillingBotId, setFillingBotId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [myTablesValue, loading] = useCollection(
    user ? query(collection(db, 'spadePledgeTables'), where('playerUids', 'array-contains', user.uid)) : null,
  );
  const myTables = (myTablesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    .filter((g) => g.status !== 'finished')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const handleCreate = async () => {
    if (!user) return;
    setCreating(true);
    setError(null);
    try {
      const tableRef = doc(collection(db, 'spadePledgeTables'));

      let code = generateGameCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await getDoc(doc(db, 'spadePledgeTableCodes', code));
        if (!existing.exists()) break;
        code = generateGameCode();
      }

      const hostPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: 0,
        team: teamForSeat(format, 0),
        isBot: false,
        consecutiveTimeouts: 0,
      };

      await setDoc(tableRef, {
        hostUid: user.uid,
        code,
        status: 'waiting',
        format,
        players: [hostPlayer],
        playerUids: [user.uid],
        groups: [],
        currentDealId: null,
        handNumber: 0,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        winnerTeam: null,
        lastHandSummary: null,
        dealHistory: [],
        rematchGameId: null,
      });
      await setDoc(doc(db, 'spadePledgeTableCodes', code), { gameId: tableRef.id, hostUid: user.uid });

      navigate(`/games/spadePledge/${tableRef.id}`);
    } catch (err) {
      console.error('Failed to create Spade Pledge table:', err);
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
      const res = await fetch('/api/spadePledge/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: tableId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete table.');
    } catch (err: any) {
      console.error('Failed to delete Spade Pledge table:', err);
      setError(err.message || 'Failed to delete table.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleFillBot = async (e: React.MouseEvent, tableId: string) => {
    e.stopPropagation();
    if (!user) return;
    setFillingBotId(tableId);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/spadePledge/fill-bot', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: tableId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to add a bot.');
    } catch (err: any) {
      console.error('Failed to add bot to Spade Pledge table:', err);
      setError(err.message || 'Failed to add a bot.');
    } finally {
      setFillingBotId(null);
    }
  };

  const handleJoinByCode = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    setJoining(true);
    setError(null);
    try {
      const codeSnap = await getDoc(doc(db, 'spadePledgeTableCodes', code));
      if (!codeSnap.exists()) {
        setError('No table found with that code.');
        return;
      }
      navigate(`/games/spadePledge/${codeSnap.data().gameId}`);
    } catch (err) {
      console.error('Failed to look up code:', err);
      setError('Failed to look up that code.');
    } finally {
      setJoining(false);
    }
  };

  return (
    <GameLobbyShell
      title="Spade Pledge"
      emoji="♠️"
      tagline="Bid, then take exactly what you pledge. Exactly 4 players."
      gradient={['#1d2b57', '#0c1230']}
      stats={lobbyStats(myTables, user?.uid, 'none')}
      ranksPath="/games/ranks/spadePledge"
      help={{ content: SPADE_PLEDGE_HELP }}
      error={showNew ? null : error}
    >
      <GoldButton onClick={() => setShowNew(true)}>＋ New table</GoldButton>

      <CodeJoin value={joinCode} onChange={setJoinCode} onJoin={handleJoinByCode} joining={joining} />

      <section className="space-y-2">
        <SectionLabel>{`Your tables · ${myTables.length}`}</SectionLabel>
        {loading && <p className="text-sm text-white/60 px-1">Loading…</p>}
        {!loading && myTables.length === 0 && <p className="text-sm text-white/50 italic px-1">No tables in progress — start one above.</p>}
        <div className="space-y-2">
          {myTables.map((g) => (
            <LobbyGameCard
              key={g.id}
              players={(g.players || []).map((p: any) => ({ uid: p.uid, photoURL: p.photoURL, displayName: p.displayName, isBot: p.isBot }))}
              title={g.status === 'waiting' ? 'Waiting for players' : 'In progress'}
              subtitle={`${FORMATS.find((f) => f.id === g.format)?.label || g.format} · code ${g.code}`}
              chip={turnChipFor(g, user?.uid, 'none')}
              onClick={() => navigate(`/games/spadePledge/${g.id}`)}
              actions={
                <>
                  {g.hostUid === user?.uid && g.status === 'waiting' && (g.players || []).length < 4 && (
                    <IconAction icon="smart_toy" label="Fill empty seat with a bot" tone="blue" onClick={(e) => handleFillBot(e, g.id)} disabled={fillingBotId === g.id} />
                  )}
                  {g.hostUid === user?.uid && g.status !== 'active' && (
                    <IconAction icon="delete" label="Delete table" onClick={(e) => handleDelete(e, g.id)} disabled={deletingId === g.id} />
                  )}
                </>
              }
            />
          ))}
        </div>
      </section>

      <NewGameSheet open={showNew} onClose={() => setShowNew(false)} title="New table" subtitle="Spade Pledge · 4 players" createLabel="Create table" creating={creating} onCreate={handleCreate} error={error}>
        <OptionCard label="Format">
          <CardPicker
            options={FORMATS.map((f) => ({ id: f.id, emoji: f.id === 'partnership' ? '🤝' : '⚔️', label: f.label, sub: f.sub }))}
            value={format}
            onChange={setFormat}
          />
        </OptionCard>
      </NewGameSheet>
    </GameLobbyShell>
  );
}
