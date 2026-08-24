import { doc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { isPresenceOnline } from '../lib/presence';

// Small green/grey presence dot for a single player, reusing the same `users/{uid}` heartbeat
// fields (`appForegroundAt`) Dashboard's Group Members list already reads. Self-contained (fetches
// its own doc) so it can just be dropped onto any avatar in a game's player list without that
// screen needing to bulk-fetch presence for everyone itself.
export default function PresenceDot({ uid, className }: { uid: string; className?: string }) {
  const [snap] = useDocument(doc(db, 'users', uid));
  const online = isPresenceOnline(snap?.data());
  return (
    <span
      title={online ? 'Online' : 'Offline'}
      className={clsx('rounded-full border-2 border-white shrink-0', online ? 'bg-success' : 'bg-text-muted/50', className)}
    />
  );
}
