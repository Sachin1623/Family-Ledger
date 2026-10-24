import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';

// The bar at the top of "my profile": Profile (how others see me) and Settings (everything on the older profile page: name, birthday, language, currency,
// reminders, security, friends and more). Shown only on my own pages.
export default function ProfileTabs({ active }: { active: 'profile' | 'settings' }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="flex bg-white rounded-2xl border border-border-subtle p-1 gap-1 shadow-sm">
      {([
        ['profile', 'Profile', 'badge', `/u/${user.uid}`],
        ['settings', 'Settings', 'settings', '/profile'],
      ] as const).map(([id, label, icon, to]) => (
        <button
          key={id}
          type="button"
          onClick={() => active !== id && navigate(to, { replace: true })}
          className={clsx('flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-black transition-all', active === id ? 'bg-primary text-white' : 'text-text-muted')}
        >
          <span className="material-symbols-outlined text-[18px]">{icon}</span>
          {label}
        </button>
      ))}
    </div>
  );
}
