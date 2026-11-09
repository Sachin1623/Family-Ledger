import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useShoppingLists } from '../lib/useShoppingLists';
import { groupEvents, startEventYear } from '../lib/shoppingEvents';
import { listIconGuess } from '../lib/shoppingIcons';
import { tileTint } from './ShoppingLists';

// One event (Diwali, Holi...) with every year it has been shopped for. "Start this year's list" copies the latest year's items into a fresh list.
export default function ShoppingEventDetail() {
  const { eventKey } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { lists, loading } = useShoppingLists(user?.uid);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const event = groupEvents(lists).find((e) => e.key === eventKey);
  const thisYear = new Date().getFullYear();

  if (loading && !event) return <div className="min-h-screen flex items-center justify-center text-text-muted">Loading…</div>;
  if (!event) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-text-muted p-6 text-center">
        <p>This event was not found.</p>
        <button type="button" onClick={() => navigate('/shopping-lists')} className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-black">Back to shopping lists</button>
      </div>
    );
  }

  const yearOf = (l: any) => Number(l.eventYear) || Number((l.createdAt || '').slice(0, 4)) || thisYear;
  const thisYearList = event.lists.find((l: any) => yearOf(l) === thisYear);
  const icon = event.icon || listIconGuess(event.name) || '🛍️';

  const start = async () => {
    if (!user) return;
    if (thisYearList) { navigate(`/shopping-lists/${thisYearList.id}`); return; }
    setStarting(true);
    setError('');
    try {
      const id = await startEventYear(user.uid, event.latest, event.name);
      navigate(`/shopping-lists/${id}`);
    } catch (err) {
      console.error('Failed to start the event list:', err);
      setError('Could not start the list. Try again.');
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-[#f2f6fa]">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-5" style={{ paddingBottom: 'calc(10rem + env(safe-area-inset-bottom))' }}>
        <div className="rounded-3xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(140deg,#7c2d12,#c2410c 55%,#f59e0b)' }}>
          <div className="flex items-center gap-3">
            <span className="w-14 h-14 rounded-2xl flex items-center justify-center text-[28px] shrink-0" style={{ background: tileTint(event.category) }}>{icon}</span>
            <div className="min-w-0">
              <p className="text-[11px] font-black uppercase tracking-wider text-white/80">Yearly event</p>
              <h1 className="text-xl font-black leading-tight break-words">{event.name}</h1>
              <p className="text-[12px] text-white/85 mt-0.5">{event.lists.length} {event.lists.length === 1 ? 'list' : 'lists'} · {event.latest.itemCount ?? 0} items last time</p>
            </div>
          </div>
          <button type="button" onClick={start} disabled={starting} className="mt-4 w-full rounded-2xl bg-white text-[#9a3412] py-3 text-sm font-black active:scale-[0.98] disabled:opacity-60">
            {starting ? 'Getting your list ready…' : thisYearList ? `Open ${thisYear}'s list` : `Start ${thisYear}'s list`}
          </button>
          {!thisYearList && <p className="text-[11px] text-white/85 mt-2 text-center">Brings every item from last time, all unticked. Nothing from the old list changes.</p>}
          {error && <p className="text-xs font-black text-white bg-rose-600/80 rounded-lg px-2 py-1 mt-2">{error}</p>}
        </div>

        <section className="space-y-2">
          <h2 className="px-1 text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">Every year</h2>
          {event.lists.map((l: any) => (
            <button key={l.id} type="button" onClick={() => navigate(`/shopping-lists/${l.id}`)} className="w-full bg-white rounded-2xl p-3 text-left shadow-[0_2px_8px_rgba(30,58,95,0.09)] active:scale-[0.99] flex items-center gap-3">
              <span className="w-11 h-11 rounded-xl flex items-center justify-center text-sm font-black bg-orange-50 text-orange-800 shrink-0">{yearOf(l)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-black text-primary truncate">{l.title}</span>
                <span className="block text-[11px] text-text-muted">
                  {l.itemCount ?? 0} items · {l.completed ? (typeof l.totalExpense === 'number' ? `spent ${l.totalExpense.toLocaleString()}` : 'finished') : `${l.doneCount || 0} done so far`}
                </span>
              </span>
              <span className={clsx('shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-black', l.completed ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800')}>{l.completed ? 'Done' : 'Active'}</span>
            </button>
          ))}
        </section>
      </main>
    </div>
  );
}
