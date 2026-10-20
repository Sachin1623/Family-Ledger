import { useMemo, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';

// Shared by every multiplayer game's waiting room (Rummy, Sequence, Ludo, Sweep, Business, Chess,
// Scramble) — candidates are the caller's group co-members who aren't already in this game, PLUS
// accepted friends passed in via `extraCandidates` (who may not share a group at all). Rendered as
// two clearly labeled sections rather than one merged pool — a flat undifferentiated list made the
// friends option invisible in practice, even though the data was already being passed in.
export default function InvitePicker({
  groupIds,
  alreadyIn,
  onInvite,
  extraCandidates,
  onSent,
}: {
  groupIds: string[];
  alreadyIn: string[];
  onInvite: (uids: string[], poke: boolean) => void | Promise<unknown>;
  // Accepted friends who may not share a group with the caller at all — shown in their own
  // "Friends" section alongside the group-co-member candidates below, so game invites reach the
  // same "everyone I know" pool the Friends screen offers, not just people already co-membered
  // into an expense group.
  extraCandidates?: { userId: string; displayName: string }[];
  // Called ~1s after a successful (non-poke) send, so the hosting sheet can close itself.
  onSent?: () => void;
}) {
  const [membersValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null,
  );

  // "Recently played with": everyone who shared a finished game with me, in ANY game that records its result
  // (gameOutcomes), most recent first. Shown as its own section on top and removed from the sections below.
  const { user } = useAuth();
  const [outcomesValue] = useCollection(user ? query(collection(db, 'gameOutcomes'), where('playerUids', 'array-contains', user.uid)) : null);
  const recentCandidates = useMemo(() => {
    const latest = new Map<string, { userId: string; displayName: string; at: string }>();
    outcomesValue?.docs.forEach((d) => {
      const g = d.data() as any;
      const at = String(g.finishedAt || '');
      (g.players || []).forEach((p: any) => {
        if (!p?.uid || p.uid === user?.uid || String(p.uid).startsWith('bot_') || p.isBot || alreadyIn.includes(p.uid)) return;
        const prev = latest.get(p.uid);
        if (!prev || at > prev.at) latest.set(p.uid, { userId: p.uid, displayName: p.displayName || prev?.displayName || 'Someone', at });
      });
    });
    return Array.from(latest.values()).sort((x, y) => (y.at > x.at ? 1 : -1)).slice(0, 8);
  }, [outcomesValue, user?.uid, alreadyIn]);
  const recentUids = useMemo(() => new Set(recentCandidates.map((c) => c.userId)), [recentCandidates]);

  const friendCandidates = useMemo(() => {
    const map = new Map<string, { userId: string; displayName: string }>();
    (extraCandidates || []).forEach((c) => {
      if (!alreadyIn.includes(c.userId)) map.set(c.userId, c);
    });
    return Array.from(map.values());
  }, [extraCandidates, alreadyIn]);

  const groupMemberCandidates = useMemo(() => {
    const friendUids = new Set(friendCandidates.map((c) => c.userId));
    const map = new Map<string, { userId: string; displayName: string }>();
    membersValue?.docs.forEach((d) => {
      const data = d.data() as any;
      // Someone who's both a friend and a group co-member shows once, under Friends only.
      if (!alreadyIn.includes(data.userId) && !friendUids.has(data.userId)) {
        map.set(data.userId, { userId: data.userId, displayName: data.displayName || 'Someone' });
      }
    });
    return Array.from(map.values());
  }, [membersValue, alreadyIn, friendCandidates]);

  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  // 'idle' -> 'sending' (the tap was accepted, request in flight) -> 'sent' (brief confirmation) -> 'idle'.
  const [phase, setPhase] = useState<{ kind: 'idle' | 'sending' | 'sent'; poke: boolean }>({ kind: 'idle', poke: false });
  const toggle = (userId: string) =>
    setSelected((s) => (s.includes(userId) ? s.filter((u) => u !== userId) : [...s, userId]));

  const hasAnyCandidates = friendCandidates.length > 0 || groupMemberCandidates.length > 0 || recentCandidates.length > 0;
  const busy = phase.kind !== 'idle';

  const byName = (a: { displayName: string }, b: { displayName: string }) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  const q = search.trim().toLowerCase();
  const visibleFriends = useMemo(
    () => friendCandidates.filter((c) => !recentUids.has(c.userId) && c.displayName.toLowerCase().includes(q)).sort(byName),
    [friendCandidates, q, recentUids],
  );
  const visibleGroup = useMemo(
    () => groupMemberCandidates.filter((c) => !recentUids.has(c.userId) && c.displayName.toLowerCase().includes(q)).sort(byName),
    [groupMemberCandidates, q, recentUids],
  );
  // Most recent first (not alphabetical), and a friend's saved name wins over the one stored in the game result.
  const visibleRecent = useMemo(() => {
    const known = new Map([...friendCandidates, ...groupMemberCandidates].map((c) => [c.userId, c.displayName]));
    return recentCandidates
      .map((c) => ({ userId: c.userId, displayName: known.get(c.userId) || c.displayName }))
      .filter((c) => c.displayName.toLowerCase().includes(q));
  }, [recentCandidates, friendCandidates, groupMemberCandidates, q]);
  const nameOf = (uid: string) => [...recentCandidates, ...friendCandidates, ...groupMemberCandidates].find((c) => c.userId === uid)?.displayName || '';

  const send = async (poke: boolean) => {
    if (busy || selected.length === 0) return;
    setPhase({ kind: 'sending', poke });
    try {
      await onInvite(selected, poke);
    } catch (err) {
      console.error('invite failed:', err);
    }
    setPhase({ kind: 'sent', poke });
    setSelected([]);
    window.setTimeout(() => {
      setPhase({ kind: 'idle', poke });
      if (!poke) onSent?.();
    }, poke ? 1600 : 1000);
  };

  const renderRow = (c: { userId: string; displayName: string }) => {
    const on = selected.includes(c.userId);
    return (
      <button
        key={c.userId}
        type="button"
        onClick={() => toggle(c.userId)}
        disabled={busy}
        aria-pressed={on}
        className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-left transition-colors ${on ? 'bg-primary/10' : 'active:bg-black/5'}`}
      >
        <span className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-xs font-black ${on ? 'bg-primary text-white' : 'bg-white border border-border-subtle text-text-muted'}`}>
          {(c.displayName.trim()[0] || '?').toUpperCase()}
        </span>
        <span className={`flex-1 min-w-0 truncate text-sm ${on ? 'font-black text-primary' : 'font-semibold text-text-main'}`}>{c.displayName}</span>
        <span className={`w-5 h-5 shrink-0 rounded-md border-2 flex items-center justify-center text-[13px] leading-none ${on ? 'bg-primary border-primary text-white' : 'border-border-subtle bg-white text-transparent'}`}>✓</span>
      </button>
    );
  };

  const Section = ({ title, list }: { title: string; list: { userId: string; displayName: string }[] }) =>
    list.length === 0 ? null : (
      <div>
        <p className="sticky top-0 z-10 bg-surface px-2.5 py-1 text-[10px] font-bold text-text-muted uppercase tracking-wider">
          {title} · {list.length}
        </p>
        <div className="space-y-0.5">{list.map((c) => renderRow(c))}</div>
      </div>
    );

  const label = (poke: boolean, idle: string) =>
    phase.kind === 'sending' && phase.poke === poke ? (
      <span className="inline-flex items-center justify-center gap-2">
        <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
        {poke ? 'Poking…' : 'Sending…'}
      </span>
    ) : phase.kind === 'sent' && phase.poke === poke ? (
      <span>✓ {poke ? 'Poked' : 'Invites sent'}</span>
    ) : (
      idle
    );

  return (
    <div className="bg-surface rounded-xl p-3 space-y-2">
      {!hasAnyCandidates && <p className="text-xs text-text-muted italic">No one available to invite yet.</p>}

      {hasAnyCandidates && (
        <>
          <div className="relative">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people"
              className="w-full bg-white border border-border-subtle rounded-xl pl-9 pr-3 py-2 text-sm outline-none focus:border-primary"
            />
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[18px] pointer-events-none">search</span>
          </div>

          {selected.length > 0 && (
            <div className="flex items-center gap-2">
              <p className="text-[11px] font-bold text-primary truncate flex-1">
                {selected.length} selected: {selected.slice(0, 3).map(nameOf).join(', ')}{selected.length > 3 ? ` +${selected.length - 3}` : ''}
              </p>
              <button type="button" onClick={() => setSelected([])} disabled={busy} className="text-[11px] font-black text-text-muted uppercase">Clear</button>
            </div>
          )}

          <div className="max-h-[42vh] overflow-y-auto -mx-1 px-1 space-y-2">
            <Section title="Recently played with" list={visibleRecent} />
            <Section title="Friends & Family" list={visibleFriends} />
            <Section title="Group Members" list={visibleGroup} />
            {visibleRecent.length === 0 && visibleFriends.length === 0 && visibleGroup.length === 0 && (
              <p className="text-xs text-text-muted italic px-2.5 py-3">No one matches "{search}".</p>
            )}
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => send(false)}
              disabled={selected.length === 0 || busy}
              className={`flex-1 py-3 rounded-xl text-sm font-bold text-white transition-colors active:scale-[0.98] ${phase.kind === 'sent' && !phase.poke ? 'bg-[#0F7A38]' : 'bg-primary'} ${selected.length === 0 && phase.kind === 'idle' ? 'opacity-40' : ''} ${busy && !(phase.kind === 'sending' && !phase.poke) && !(phase.kind === 'sent' && !phase.poke) ? 'opacity-40' : ''}`}
            >
              {label(false, `Send Invite${selected.length !== 1 ? 's' : ''}${selected.length > 0 ? ` (${selected.length})` : ''}`)}
            </button>
            <button
              type="button"
              onClick={() => send(true)}
              disabled={selected.length === 0 || busy}
              className={`flex-1 py-3 rounded-xl text-sm font-bold bg-primary/10 text-primary transition-colors active:scale-[0.98] ${selected.length === 0 && phase.kind === 'idle' ? 'opacity-40' : ''} ${busy && !(phase.kind !== 'idle' && phase.poke) ? 'opacity-40' : ''}`}
            >
              {label(true, '✋ Poke to Join')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
