import { useMemo, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';

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
}: {
  groupIds: string[];
  alreadyIn: string[];
  onInvite: (uids: string[], poke: boolean) => void;
  // Accepted friends who may not share a group with the caller at all — shown in their own
  // "Friends" section alongside the group-co-member candidates below, so game invites reach the
  // same "everyone I know" pool the Friends screen offers, not just people already co-membered
  // into an expense group.
  extraCandidates?: { userId: string; displayName: string }[];
}) {
  const [membersValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null,
  );

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
  const toggle = (userId: string) =>
    setSelected((s) => (s.includes(userId) ? s.filter((u) => u !== userId) : [...s, userId]));

  const hasAnyCandidates = friendCandidates.length > 0 || groupMemberCandidates.length > 0;

  return (
    <div className="bg-surface rounded-xl p-3 space-y-3">
      {!hasAnyCandidates && <p className="text-xs text-text-muted italic">No one available to invite yet.</p>}

      {friendCandidates.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Friends & Family</p>
          <div className="flex flex-wrap gap-2">
            {friendCandidates.map((c) => (
              <button
                key={c.userId}
                onClick={() => toggle(c.userId)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold border ${
                  selected.includes(c.userId) ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'
                }`}
              >
                {c.displayName}
              </button>
            ))}
          </div>
        </div>
      )}

      {groupMemberCandidates.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Group Members</p>
          <div className="flex flex-wrap gap-2">
            {groupMemberCandidates.map((c) => (
              <button
                key={c.userId}
                onClick={() => toggle(c.userId)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold border ${
                  selected.includes(c.userId) ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'
                }`}
              >
                {c.displayName}
              </button>
            ))}
          </div>
        </div>
      )}

      {hasAnyCandidates && (
        <div className="flex gap-2">
          <button
            onClick={() => onInvite(selected, false)}
            disabled={selected.length === 0}
            className="flex-1 py-2 bg-primary text-white rounded-xl text-xs font-bold disabled:opacity-40"
          >
            Send Invite{selected.length !== 1 ? 's' : ''}
          </button>
          <button
            onClick={() => onInvite(selected, true)}
            disabled={selected.length === 0}
            className="flex-1 py-2 bg-primary/10 text-primary rounded-xl text-xs font-bold disabled:opacity-40"
          >
            ✋ Poke to Join
          </button>
        </div>
      )}
    </div>
  );
}
