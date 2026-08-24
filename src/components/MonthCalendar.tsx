import React from 'react';
import { clsx } from 'clsx';
import { useLanguage } from '../context/LanguageContext';

export interface MonthCursor {
  year: number;
  month: number;
}

const toDateOnly = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const TODAY_STR = toDateOnly(new Date());

// Index-aligned with Date.getMonth() / Date.getDay() so cursor.month and a cell's weekday column
// can index straight into these without an offset.
export const MONTH_KEYS = [
  'month.january', 'month.february', 'month.march', 'month.april', 'month.may', 'month.june',
  'month.july', 'month.august', 'month.september', 'month.october', 'month.november', 'month.december',
];
const WEEKDAY_SHORT_KEYS = [
  'weekday.sunShort', 'weekday.monShort', 'weekday.tueShort', 'weekday.wedShort',
  'weekday.thuShort', 'weekday.friShort', 'weekday.satShort',
];

// Shared by Recurring Expenses, To-Do, and Expense Reminders — all three had their own copy of
// this exact month-grid calendar (only the per-day dot content differed), so a visual restyle
// meant three separate edits drifting slightly out of sync. One component now, styled larger and
// more spacious, with a collapse toggle so it doesn't have to eat screen space once you've seen
// what's due this month.
export default function MonthCalendar({
  cursor,
  onCursorChange,
  selectedDate,
  onSelectDate,
  renderDayDots,
  dayHasActivity,
  dayTitle,
  defaultExpanded = false,
  storageKey,
}: {
  cursor: MonthCursor;
  onCursorChange: (next: MonthCursor) => void;
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
  renderDayDots?: (dateStr: string) => React.ReactNode;
  dayHasActivity?: (dateStr: string) => boolean;
  dayTitle?: (dateStr: string) => string | undefined;
  defaultExpanded?: boolean;
  // Remembers collapsed/expanded per screen (e.g. 'todo-calendar-expanded') across visits —
  // omit for a session-only default.
  storageKey?: string;
}) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = React.useState(() => {
    if (!storageKey || typeof localStorage === 'undefined') return defaultExpanded;
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? defaultExpanded : stored === '1';
    } catch {
      return defaultExpanded;
    }
  });
  React.useEffect(() => {
    if (!storageKey || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(storageKey, expanded ? '1' : '0');
    } catch {
      // ignore — collapse state just won't persist this session
    }
  }, [expanded, storageKey]);

  const cells = React.useMemo(() => {
    const { year, month } = cursor;
    const firstWeekday = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    const result: (string | null)[] = Array(firstWeekday).fill(null);
    for (let day = 1; day <= totalDays; day++) result.push(toDateOnly(new Date(year, month, day)));
    return result;
  }, [cursor]);

  const goPrev = () => onCursorChange(cursor.month === 0 ? { year: cursor.year - 1, month: 11 } : { year: cursor.year, month: cursor.month - 1 });
  const goNext = () => onCursorChange(cursor.month === 11 ? { year: cursor.year + 1, month: 0 } : { year: cursor.year, month: cursor.month + 1 });

  return (
    <div className="bg-white rounded-2xl border border-border-subtle p-3 space-y-2 w-full">
      <div className="flex items-center justify-between px-0.5">
        <button type="button" onClick={goPrev} className="p-1.5 text-text-muted hover:text-primary hover:bg-surface rounded-full transition-colors">
          <span className="material-symbols-outlined text-[18px] block">chevron_left</span>
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-sm font-bold text-primary px-2 py-1 rounded-lg hover:bg-surface transition-colors"
        >
          {t(MONTH_KEYS[cursor.month])} {cursor.year}
          <span className="material-symbols-outlined text-[16px]">{expanded ? 'expand_less' : 'expand_more'}</span>
        </button>
        <button type="button" onClick={goNext} className="p-1.5 text-text-muted hover:text-primary hover:bg-surface rounded-full transition-colors">
          <span className="material-symbols-outlined text-[18px] block">chevron_right</span>
        </button>
      </div>

      {expanded && (
        <div className="grid grid-cols-7 gap-1 text-center">
          {WEEKDAY_SHORT_KEYS.map((key) => (
            <p key={key} className="text-[9px] font-bold text-text-muted uppercase">{t(key)}</p>
          ))}
          {cells.map((dateStr, i) => {
            if (!dateStr) return <div key={`blank-${i}`} />;
            const isToday = dateStr === TODAY_STR;
            const isSelected = dateStr === selectedDate;
            const hasActivity = dayHasActivity?.(dateStr) ?? false;
            return (
              <button
                type="button"
                key={dateStr}
                title={dayTitle?.(dateStr)}
                onClick={() => onSelectDate(isSelected ? null : dateStr)}
                className={clsx(
                  'h-11 rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-bold leading-none transition-all',
                  isSelected
                    ? 'bg-primary text-white'
                    : isToday
                    ? 'border-2 border-primary text-primary bg-primary/5'
                    : hasActivity
                    ? 'bg-[#4ADE80]/15 text-on-surface hover:bg-[#4ADE80]/25'
                    : 'text-on-surface hover:bg-surface-container',
                )}
              >
                <span>{Number(dateStr.slice(-2))}</span>
                {renderDayDots?.(dateStr)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
