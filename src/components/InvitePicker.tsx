import { useMemo, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';

// Shared by every multiplayer game's waiting room (Rummy, Sequence, Ludo, Sweep, Business, Chess)
// — candidates are always the caller's group co-members who aren't already in this game. There's
// no persisted "who was already invited" record for games (unlike group invites), so "Poke to
// Join" targets the exact same candidate pool as "Send Invite": it's just the nudge-toned version
// of the same notification, for people who were invited earlier but haven't joined yet.
export default function InvitePicker({
  groupIds,
  alreadyIn,
  onInvite,
  extraCandidates,
}: {
  groupIds: string[];
  alreadyIn: string[];
  onInvite: (uids: string[], poke: boolean) => void;
  // Accepted friends who may not share a group with the caller at all — merged in alongside the
  // group-co-member candidates below so game invites reach the same "everyone I know" pool the
  // Friends screen offers, not just people already co-membered into an expense group.
  extraCandidates?: { userId: string; displayName: string }[];
}) {
  const [membersValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null,
  );
  const candidates = useMemo(() => {
    const map = new Map<string, { userId: string; displayName: string }>();
    membersValue?.docs.forEach((d) => {
      const data = d.data() as any;
      if (!alreadyIn.includes(data.userId)) map.set(data.userId, { userId: data.userId, displayName: data.displayName || 'Someone' });
    });
    (extraCandidates || []).forEach((c) => {
      if (!alreadyIn.includes(c.userId)) map.set(c.userId, c);
    });
    return Array.from(map.values());
  }, [membersValue, alreadyIn, extraCandidates]);
  const [selected, setSelected] = useState<string[]>([]);

  return (
    <div className="bg-surface rounded-xl p-3 space-y-2">
      {candidates.length === 0 && <p className="text-xs text-text-muted italic">No group members available to invite.</p>}
      <div className="flex flex-wrap gap-2">
        {candidates.map((c) => (
          <button
            key={c.userId}
            onClick={() => setSelected((s) => (s.includes(c.userId) ? s.filter((u) => u !== c.userId) : [...s, c.userId]))}
            className={`px-3 py-1.5 rounded-full text-xs font-bold border ${
              selected.includes(c.userId) ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'
            }`}
          >
            {c.displayName}
          </button>
        ))}
      </div>
      {candidates.length > 0 && (
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
