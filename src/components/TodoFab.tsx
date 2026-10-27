import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';

// A floating icon, always there above the quest trophy, that opens the To-Do list and looks different for each situation:
//   overdue            red ring, red count of what is due today or late
//   due today          amber ring, amber count
//   open but not today blue ring, no number (nothing is due today)
//   all done           green ring with a tick
//   nothing yet        quiet dashed ring with a plus, tap to add the first one
// It listens to my own to-dos only (habits that repeat are left out, they have their own tiles on the list).

const HIDE_PREFIXES = ['/settlements', '/my-style', '/u', '/todo', '/games', '/admin', '/login', '/add-expense', '/profile', '/chat', '/join', '/groups/join', '/onboarding'];

const toDateOnly = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

type Task = { done: boolean; dueDate: string | null };

export default function TodoFab() {
  const { user, profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [today, setToday] = useState(() => toDateOnly(new Date()));

  useEffect(() => {
    if (!user) {
      setTasks(null);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, 'todos'), where('userId', '==', user.uid)),
      (snap) => setTasks(snap.docs.map((d) => d.data() as any).filter((t) => !t.recurring).map((t) => ({ done: !!t.done, dueDate: typeof t.dueDate === 'string' && t.dueDate ? t.dueDate : null }))),
      () => setTasks([]),
    );
    return unsub;
  }, [user?.uid]);

  // "today" moves on at midnight even if the app stays open
  useEffect(() => {
    const t = setInterval(() => setToday(toDateOnly(new Date())), 60_000);
    return () => clearInterval(t);
  }, []);

  const hidden = HIDE_PREFIXES.some((p) => location.pathname === p || location.pathname.startsWith(`${p}/`)) || /^\/groups\/[^/]+\/manage$/.test(location.pathname) || location.pathname.startsWith('/shopping-lists/'); // a shopping list has its own add-item bar
  if (!user || hidden || tasks === null) return null;

  const open = tasks.filter((t) => !t.done);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < today).length;
  const dueNow = open.filter((t) => t.dueDate && t.dueDate <= today).length;

  // the look for the situation we are in
  let state: 'overdue' | 'today' | 'open' | 'done' | 'empty';
  if (overdue > 0) state = 'overdue';
  else if (dueNow > 0) state = 'today';
  else if (open.length > 0) state = 'open';
  else if (tasks.length > 0) state = 'done';
  else state = 'empty';

  const look = {
    overdue: { border: '#f43f5e', icon: 'checklist', color: '#e11d48', count: dueNow, badge: 'bg-rose-500', label: `${dueNow} to-do${dueNow === 1 ? '' : 's'} due or overdue` },
    today: { border: '#f59e0b', icon: 'checklist', color: '#d97706', count: dueNow, badge: 'bg-amber-500', label: `${dueNow} to-do${dueNow === 1 ? '' : 's'} due today` },
    open: { border: '#38bdf8', icon: 'checklist', color: '#0284c7', count: 0, badge: 'bg-sky-500', label: `${open.length} open to-do${open.length === 1 ? '' : 's'}, none due today` },
    done: { border: '#22c55e', icon: 'task_alt', color: '#16a34a', count: 0, badge: 'bg-green-500', label: 'All to-dos done' },
    empty: { border: '#cbd5e1', icon: 'add_task', color: '#64748b', count: 0, badge: '', label: 'Add a to-do' },
  }[state];

  // sits above the quest trophy when that is showing (it is 60px tall), otherwise in its place
  const lift = profile?.questsEnabled !== false ? 72 : 0;

  return (
    <button
      type="button"
      onClick={() => navigate('/todo')}
      aria-label={look.label}
      title={look.label}
      className="fixed left-4 z-40 w-[52px] h-[52px] rounded-full bg-white shadow-lg flex items-center justify-center active:scale-95 transition-transform"
      style={{ bottom: `calc(4rem + env(safe-area-inset-bottom) + 12px + ${lift}px)`, border: `3px ${state === 'empty' ? 'dashed' : 'solid'} ${look.border}` }}
    >
      <span className="material-symbols-outlined text-[26px]" style={{ color: look.color, fontVariationSettings: `'FILL' ${state === 'empty' ? 0 : 1}` }}>{look.icon}</span>
      {look.count > 0 && (
        <span className={`absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full text-white text-[11px] font-black flex items-center justify-center shadow ring-2 ring-white ${look.badge}`}>{look.count > 99 ? '99+' : look.count}</span>
      )}
      {state === 'done' && (
        <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-green-500 ring-2 ring-white flex items-center justify-center">
          <span className="material-symbols-outlined text-white text-[14px]" style={{ fontVariationSettings: "'wght' 700" }}>check</span>
        </span>
      )}
    </button>
  );
}
