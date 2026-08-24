import React from 'react';
import { clsx } from 'clsx';
import { FrequencyConfig, FREQUENCY_OPTIONS, WEEKDAY_LABELS, MONTH_LABELS, resolveDaysOfWeek, reminderTimeOfDay, firstOccurrenceOnOrAfter, formatTimeOfDay } from '../lib/frequency';

// Frequency + the extra fields each frequency needs (which day for weekly, which day-of-month
// for monthly+, which anchor month for quarterly/half-yearly/annually). Shared by recurring
// expenses and expense reminders so the two forms stay consistent.
export default function FrequencyPicker({
  config,
  onChange,
}: {
  config: FrequencyConfig;
  onChange: (config: FrequencyConfig) => void;
}) {
  const needsDayOfMonth = ['monthly', 'alternate_month', 'quarterly', 'half_yearly', 'annually'].includes(config.frequency);
  const needsMonth = ['alternate_month', 'quarterly', 'half_yearly', 'annually'].includes(config.frequency);
  const { hour: currentHour, minute: currentMinute } = reminderTimeOfDay(config);

  // Live preview of what these settings actually resolve to — recomputed on every change so the
  // user can confirm the rule fires when they expect before saving, instead of only finding out
  // from the list/calendar afterward.
  const nextOccurrence = React.useMemo(() => {
    try {
      return firstOccurrenceOnOrAfter(config, new Date());
    } catch {
      return null;
    }
  }, [config]);

  return (
    <div className="space-y-3">
      {nextOccurrence && (
        <div className="flex items-center gap-2 bg-primary/5 border border-primary/10 rounded-xl px-3 py-2">
          <span className="material-symbols-outlined text-[16px] text-primary shrink-0">event_upcoming</span>
          <p className="text-[11px] font-bold text-primary">
            Next: {nextOccurrence.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at {formatTimeOfDay(currentHour, currentMinute)}
          </p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Frequency</label>
          <select
            value={config.frequency}
            onChange={(e) => onChange({ ...config, frequency: e.target.value as FrequencyConfig['frequency'] })}
            className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
          >
            {FREQUENCY_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Reminder time</label>
          <input
            type="time"
            value={`${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`}
            onChange={(e) => {
              const [h, m] = e.target.value.split(':').map(Number);
              onChange({ ...config, hour: h, minute: m });
            }}
            className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      {config.frequency === 'weekly' && (() => {
        const selectedDays = resolveDaysOfWeek(config);
        const toggleDay = (idx: number) => {
          const next = selectedDays.includes(idx)
            ? selectedDays.filter((d) => d !== idx)
            : [...selectedDays, idx];
          if (next.length === 0) return; // at least one day must stay selected
          onChange({ ...config, daysOfWeek: next, dayOfWeek: undefined });
        };
        return (
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Which day(s)?</label>
            <div className="flex flex-wrap gap-2">
              {WEEKDAY_LABELS.map((label, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => toggleDay(idx)}
                  className={clsx(
                    'px-3 py-1.5 rounded-full border text-[11px] font-bold transition-all',
                    selectedDays.includes(idx)
                      ? 'bg-primary text-white border-primary'
                      : 'bg-white text-on-surface border-border-subtle hover:bg-surface-container',
                  )}
                >
                  {label.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {needsMonth && (
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">
            {config.frequency === 'annually' ? 'Which month?' : 'Starting month'}
          </label>
          <select
            value={config.month ?? 1}
            onChange={(e) => onChange({ ...config, month: Number(e.target.value) })}
            className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
          >
            {MONTH_LABELS.map((label, idx) => (
              <option key={idx} value={idx + 1}>{label}</option>
            ))}
          </select>
        </div>
      )}

      {needsDayOfMonth && (
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Which date?</label>
          <select
            value={config.dayOfMonth ?? 1}
            onChange={(e) => onChange({ ...config, dayOfMonth: Number(e.target.value) })}
            className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
          >
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
