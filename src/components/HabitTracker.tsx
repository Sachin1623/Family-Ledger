import React, { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { isDueOnDate, frequencyConfigFromFields, WEEKDAY_LABELS } from '../lib/frequency';
import { useLanguage } from '../context/LanguageContext';

const toDateOnly = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const startOfWeekMonday = (d: Date) => {
  const copy = new Date(d);
  const day = copy.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  copy.setDate(copy.getDate() + diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

type CellState = 'not-due' | 'done' | 'missed';

// Weekly/monthly grid view of recurring to-dos ("habits") — rows are habits, columns are days,
// each cell colored grey (not scheduled that day), green (scheduled and completed), or red
// (scheduled and not completed). A habit's `history` map (see processRecurringTodos in server.ts)
// carries each past occurrence's outcome forward after the live `done`/`status` fields get reset
// for the next occurrence; today's cell instead reads `done` live so toggling it here and toggling
// it from the regular list view stay in sync. Only today and past days are tappable — a future
// occurrence hasn't happened yet, so there's nothing to mark.
export default function HabitTracker({
  todos,
  onToggleDay,
  onSelectHabit,
  onTogglePause,
  searchActive = false,
}: {
  todos: any[];
  onToggleDay: (todo: any, dateStr: string, nextDone: boolean) => void;
  onSelectHabit: (todo: any) => void;
  onTogglePause: (todo: any) => void;
  searchActive?: boolean;
}) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [cursor, setCursor] = useState(() => new Date());
  const todayStr = toDateOnly(new Date());

  const weekDates = useMemo(() => {
    if (mode !== 'week') return [];
    const start = startOfWeekMonday(cursor);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [mode, cursor]);

  const monthDates = useMemo(() => {
    if (mode !== 'month') return [];
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const days = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: days }, (_, i) => new Date(year, month, i + 1));
  }, [mode, cursor]);

  const dates = mode === 'week' ? weekDates : monthDates;

  const shift = (delta: number) => {
    const d = new Date(cursor);
    if (mode === 'week') d.setDate(d.getDate() + delta * 7);
    else d.setMonth(d.getMonth() + delta);
    setCursor(d);
  };

  const cellState = (todo: any, date: Date): CellState => {
    const dateStr = toDateOnly(date);
    const createdStr = toDateOnly(new Date(todo.createdAt));
    if (dateStr < createdStr) return 'not-due';
    const due = isDueOnDate(frequencyConfigFromFields(todo), dateStr, createdStr);
    if (!due) return 'not-due';
    if (dateStr > todayStr) return 'not-due';
    const completed = dateStr === todayStr ? !!todo.done : todo.history?.[dateStr] === true;
    return completed ? 'done' : 'missed';
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 bg-surface-container rounded-xl p-1">
          {(['week', 'month'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-xs font-bold transition-all',
                mode === m ? 'bg-white text-primary shadow-sm' : 'text-text-muted',
              )}
            >
              {m === 'week' ? t('todo.weekly') : t('todo.monthly')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => shift(-1)} className="p-1.5 text-text-muted hover:text-primary">
            <span className="material-symbols-outlined text-[18px]">chevron_left</span>
          </button>
          <p className="text-xs font-bold text-on-surface min-w-[100px] text-center">
            {mode === 'week'
              ? `${weekDates[0]?.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${weekDates[6]?.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
              : cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </p>
          <button type="button" onClick={() => shift(1)} className="p-1.5 text-text-muted hover:text-primary">
            <span className="material-symbols-outlined text-[18px]">chevron_right</span>
          </button>
        </div>
      </div>

      {todos.length === 0 ? (
        <p className="text-sm text-text-muted italic px-1">{searchActive ? t('todo.noSearchResults') : t('todo.noHabitsYet')}</p>
      ) : (
        <div className="bg-white rounded-2xl border border-border-subtle overflow-x-auto">
          <table className="border-collapse w-full">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white text-left text-[10px] font-bold text-text-muted uppercase tracking-wider px-3 py-2 min-w-[120px]">
                  {t('todo.habit')}
                </th>
                {dates.map((d) => {
                  const dateStr = toDateOnly(d);
                  return (
                    <th key={dateStr} className={clsx('px-1 py-2 text-center min-w-[36px]', dateStr === todayStr && 'bg-primary/5')}>
                      <p className="text-[9px] font-bold text-text-muted uppercase">
                        {mode === 'week' ? WEEKDAY_LABELS[d.getDay()].slice(0, 2) : ''}
                      </p>
                      <p className="text-[10px] font-bold text-on-surface">{d.getDate()}</p>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {todos.map((todo) => (
                <tr key={todo.id} className={clsx('border-t border-border-subtle', todo.recurringActive === false && 'opacity-50')}>
                  <td className="sticky left-0 bg-white px-3 py-2 max-w-[160px]">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSelectHabit(todo)}
                        className="text-xs font-bold text-on-surface truncate flex-1 text-left hover:text-primary"
                      >
                        {todo.text}
                      </button>
                      <button
                        type="button"
                        onClick={() => onTogglePause(todo)}
                        title={t(todo.recurringActive === false ? 'reminders.resume' : 'reminders.pause')}
                        className="p-1 text-text-muted hover:text-primary shrink-0"
                      >
                        <span className="material-symbols-outlined text-[16px] block">
                          {todo.recurringActive === false ? 'play_circle' : 'pause_circle'}
                        </span>
                      </button>
                    </div>
                  </td>
                  {dates.map((d) => {
                    const dateStr = toDateOnly(d);
                    const state = cellState(todo, d);
                    const interactive = state !== 'not-due';
                    return (
                      <td key={dateStr} className={clsx('px-1 py-2 text-center', dateStr === todayStr && 'bg-primary/5')}>
                        <button
                          type="button"
                          disabled={!interactive}
                          onClick={() => interactive && onToggleDay(todo, dateStr, state !== 'done')}
                          title={
                            state === 'not-due' ? t('todo.habitNotDue') : state === 'done' ? t('todo.habitCompleted') : t('todo.habitMissed')
                          }
                          className={clsx(
                            'w-6 h-6 rounded-lg flex items-center justify-center mx-auto transition-all',
                            state === 'not-due' && 'bg-surface-container',
                            state === 'done' && 'bg-success text-white active:scale-90',
                            state === 'missed' && 'bg-error/15 text-error border border-error/30 active:scale-90',
                          )}
                        >
                          {state === 'done' && <span className="material-symbols-outlined text-[14px]">check</span>}
                          {state === 'missed' && <span className="material-symbols-outlined text-[14px]">close</span>}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
