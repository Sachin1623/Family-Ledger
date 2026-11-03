import React from 'react';
import { useLanguage } from '../context/LanguageContext';

// Shared read-only "view details" shell for list rows that previously only exposed their full
// detail via the edit form (To-Do, Recurring Expenses, Scheduled reminders) — tapping a row now
// opens this instead of jumping straight into editing, with explicit Edit/Delete buttons at the
// bottom for anyone who actually wants to change or remove it. Same bottom-sheet-on-mobile /
// centered-card-on-larger-screens shell as ExpenseQuickView.tsx, so it feels consistent with the
// one detail view the app already had.
export default function DetailSheet({
  title,
  onClose,
  onEdit,
  onDelete,
  onDone,
  doneLabel,
  deleteInHeader,
  aboveNav,
  children,
}: {
  title: string;
  onClose: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onDone?: () => void; // a primary Done button at the bottom
  doneLabel?: string;
  deleteInHeader?: boolean; // delete goes to the top left of the header instead of the bottom row
  aboveNav?: boolean; // stop above the bottom bar instead of running down over it
  children: React.ReactNode;
}) {
  const { t } = useLanguage();
  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center" style={aboveNav ? { paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' } : undefined} onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className={`relative w-full sm:max-w-md bg-white ${aboveNav ? 'rounded-3xl' : 'rounded-t-3xl sm:rounded-3xl'} shadow-2xl flex flex-col max-h-[85vh] overflow-hidden`} style={aboveNav ? { maxHeight: 'calc(100dvh - 4rem - env(safe-area-inset-bottom) - 3rem)' } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border-subtle flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {onDelete && deleteInHeader && (
              <button onClick={onDelete} title={t('common.delete')} aria-label={t('common.delete')} className="p-2 -ml-2 hover:bg-error/10 rounded-full text-error shrink-0">
                <span className="material-symbols-outlined">delete</span>
              </button>
            )}
            <h2 className="text-base font-bold text-primary truncate">{title}</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-surface rounded-full">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">{children}</div>
        {(onEdit || (onDelete && !deleteInHeader) || onDone) && (
          <div
            className="p-4 border-t border-border-subtle shrink-0 flex gap-2"
            style={{ paddingBottom: aboveNav ? '1rem' : 'calc(1rem + env(safe-area-inset-bottom))' }}
          >

            {onEdit && (
              <button
                onClick={onEdit}
                className="flex-1 h-12 border-2 border-border-subtle text-primary font-bold rounded-xl active:scale-95 transition-all text-sm flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[18px]">edit</span>
                {t('common.edit')}
              </button>
            )}
            {onDelete && !deleteInHeader && (
              <button
                onClick={onDelete}
                className="flex-1 h-12 border-2 border-error/30 text-error font-bold rounded-xl active:scale-95 transition-all text-sm flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
                {t('common.delete')}
              </button>
            )}
            {onDone && (
              <button
                onClick={onDone}
                className="flex-1 h-12 bg-primary text-white font-bold rounded-xl active:scale-95 transition-all text-sm flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[18px]">check</span>
                {doneLabel || t('common.done')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// A label/value pair, the recurring building block inside a DetailSheet's body.
export function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{label}</p>
      <div className="text-sm font-medium text-on-surface break-words">{children}</div>
    </div>
  );
}
