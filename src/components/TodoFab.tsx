import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';

// A floating icon, above the quest trophy, that shows how many of my to-dos need attention today (due today or already overdue). It appears only when there
// are some, turns red when any are overdue, and opens the To-Do list. It listens to my own unfinished to-dos only, so it stays light.

const HIDE_PREFIXES = ['/settlements', '/my-style', '/u', '/todo', '/games', '/admin', '/login', '/add-expense', '/profile', '/chat', '/join', '/groups/join', '/onboarding'];

const toDateOnly = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function TodoFab() {
  const { user, profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [dueDates, setDueDates] = useState<string[]>([]);
  const [today, setToday] = useState(() => toDateOnly(new Date()));

  useEffect(() => {
    if (!user) {
      setDueDates([]);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, 'todos'), where('userId', '==', user.uid), where('done', '==', false)),
      (snap) => setDueDates(snap.docs.map((d) => d.data()).filter((t: any) => !t.recurring && typeof t.dueDate === 'string' && t.dueDate).map((t: any) => t.dueDate as string)),
      () => setDueDates([]),
    );
    return unsub;
  }, [user?.uid]);

  // "today" moves on at midnight even if the app stays open
  useEffect(() => {
    const t = setInterval(() => setToday(toDateOnly(new Date())), 60_000);
    return () => clearInterval(t);
  }, []);

  const hidden = HIDE_PREFIXES.some((p) => location.pathname === p || location.pathname.startsWith(`${p}/`)) || /^\/groups\/[^/]+\/manage$/.test(location.pathname);
  const dueNow = dueDates.filter((d) => d <= today);
  const overdue = dueDates.filter((d) => d < today).length;
  if (!user || hidden || dueNow.length === 0) return null;

  // sits above the quest trophy when that is showing (it is 60px tall), otherwise in its place
  const questShowing = profile?.questsEnabled !== false;
  const lift = questShowing ? 72 : 0;
  const red = overdue > 0;

  return (
    <button
      type="button"
      onClick={() => navigate('/todo')}
      aria-label={`${dueNow.length} to-do${dueNow.length === 1 ? '' : 's'} need attention`}
      className="fixed left-4 z-40 w-[52px] h-[52px] rounded-full bg-white shadow-lg flex items-center justify-center active:scale-95 transition-transform"
      style={{ bottom: `calc(4rem + env(safe-area-inset-bottom) + 12px + ${lift}px)`, border: `3px solid ${red ? '#f43f5e' : '#f59e0b'}` }}
    >
      <span className="material-symbols-outlined text-[26px]" style={{ color: red ? '#e11d48' : '#d97706', fontVariationSettings: "'FILL' 1" }}>checklist</span>
      <span className={`absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full text-white text-[11px] font-black flex items-center justify-center shadow ring-2 ring-white ${red ? 'bg-rose-500' : 'bg-amber-500'}`}>{dueNow.length > 99 ? '99+' : dueNow.length}</span>
    </button>
  );
}
