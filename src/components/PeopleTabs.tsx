import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useFriendRequestCount } from '../lib/useFriendRequestCount';

// "Chats | Friends": the two halves of the people side of the app, reached from the chat icon in the header. A red count on Friends says how
// many friend requests are waiting for an answer.
export default function PeopleTabs({ active }: { active: 'chats' | 'friends' }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const waiting = useFriendRequestCount(user?.uid);
  if (!user) return null;
  return (
    <div className="flex bg-[#eaf0f3] rounded-2xl p-1 gap-1" role="tablist">
      {([
        ['chats', 'Chats', '/chat', 0],
        ['friends', 'Friends', '/friends', waiting],
      ] as const).map(([id, label, to, count]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          onClick={() => active !== id && navigate(to, { replace: true })}
          className={clsx('flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-extrabold transition-all', active === id ? 'bg-white text-primary shadow-sm' : 'text-text-muted')}
        >
          {label}
          {count > 0 && <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-error text-white text-[10px] font-black flex items-center justify-center">{count}</span>}
        </button>
      ))}
    </div>
  );
}
